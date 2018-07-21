'use strict';

const express = require('express');
const router = express.Router();
const yaml = require('js-yaml');

const utils = require('./utils');
const pluginUtils = require('./pluginUtils');

router.get('/', function (req, res, next) {
    const apis = utils.loadApis(req.app);
    const plans = utils.loadPlans(req.app);
    const groups = utils.loadGroups(req.app);
    const authServers = utils.getAuthServers(req.app);
    for (let i = 0; i < apis.apis.length; ++i) {
        if (!apis.apis[i].authServers) {
            apis.apis[i].authServers = {};
        } else {
            const obAuthServers = {};
            for (let j = 0; j < apis.apis[i].authServers.length; ++j) {
                const safeName = apis.apis[i].authServers[j].replace(/\-/g, '_');
                obAuthServers[safeName] = true;
            }
            apis.apis[i].authServers = obAuthServers;
        }
    }
    console.log(JSON.stringify(apis, null, 2));

    res.render('apis',
        {
            configPath: req.app.get('config_path'),
            envFile: req.app.get('env_file'),
            title: 'wicked - Kickstarter',
            apis: apis.apis,
            plans: plans.plans,
            groups: groups.groups,
            authServers: authServers
        });
});

router.post('/', function (req, res, next) {
    const redirect = req.body.redirect;
    const body = utils.jsonifyBody(req.body);

    const authServers = utils.getAuthServers(req.app);
    const authServerSafeNames = {};
    for (let i = 0; i < authServers.length; ++i) {
        const serverName = authServers[i];
        authServerSafeNames[serverName.replace(/\-/g, '_')] = serverName;
    }

    if ("addApi" == body.__action) {
        console.log("Add API");

        let apis = utils.loadApis(req.app);
        let newApiId = body.newApiId;
        if (newApiId.length < 3)
            return next(utils.makeError(400, 'API ID must be longer than or equal 3 characters.'));
        if (!/^[a-z\-_]+$/.test(newApiId))
            return next(utils.makeError(400, 'API ID can only contain a-z, - and _.'));
        apis.apis.push({
            id: newApiId,
            name: newApiId,
            desc: newApiId,
            auth: "key-auth",
            tags: [],
            plans: []
        });

        utils.prepareNewApi(req.app, newApiId);
        utils.saveApis(req.app, apis);

        return res.redirect(redirect);
    } else if ("deleteApi" == body.__action) {
        let apiIndex = Number(body.__object);

        let apis = utils.loadApis(req.app);
        let apiId = apis.apis[apiIndex].id;
        apis.apis.splice(apiIndex, 1);
        utils.saveApis(req.app, apis);
        utils.removeApiDir(req.app, apiId);

        return res.redirect(redirect);
    }

    for (let i = 0; i < body.apis.length; ++i) {
        let thisApi = body.apis[i];
        let tags = thisApi.tags.split(',');
        if (thisApi.tags !== '')
            thisApi.tags = tags;
        else
            thisApi.tags = [];

        let plans = [];
        for (let planName in thisApi.plans)
            plans.push(planName);
        thisApi.plans = plans;

        const authServers = [];
        console.log(thisApi);
        for (let authServerName in thisApi.authServers) {
            console.log('authServerName: ' + authServerName);
            const realName = authServerSafeNames[authServerName];
            if (thisApi.authServers[authServerName] && realName)
                authServers.push(realName);
        }
        console.log(authServers);
        if (authServers.length > 0)
            thisApi.authServers = authServers;
        else if (thisApi.authServers)
            delete thisApi.authServers;
    }

    let apis = utils.loadApis(req.app);
    apis.apis = body.apis;
    for (let i = 0; i < apis.apis.length; ++i) {
        if (apis.apis[i].requiredGroup == '<none>')
            delete apis.apis[i].requiredGroup;
    }

    utils.saveApis(req.app, apis);

    // Write changes to Kickstarter.json
    const kickstarter = utils.loadKickstarter(req.app);
    kickstarter.apis = 3;
    utils.saveKickstarter(req.app, kickstarter);

    res.redirect(redirect);
});

router.get('/:apiId', function (req, res, next) {
    const apiId = req.params.apiId;
    const safeApiId = utils.makeSafeId(apiId);
    const apis = utils.loadApis(req.app);
    const thisApi = apis.apis.find(a => a.id === apiId);
    if (!thisApi.hasOwnProperty('requiredGroup'))
        thisApi.requiredGroup = '';
    const config = utils.loadApiConfig(req.app, apiId);
    const plugins = pluginUtils.makeViewModel(config.plugins);
    const apiDesc = utils.loadApiDesc(req.app, apiId);
    const apiSwagger = JSON.stringify(utils.loadSwagger(req.app, apiId), null, 2);

    // Assemble all auth methods
    const authServerNames = utils.getAuthServers(req.app);
    const authMethods = [];
    for (let as in authServerNames) {
        const asName = authServerNames[as];
        const authServer = utils.loadAuthServer(req.app, asName);
        for (let i = 0; i < authServer.authMethods.length; ++i) {
            const thisAm = authServer.authMethods[i];
            thisAm.serverId = asName;
            authMethods.push(thisAm);
        }
    }

    const groups = utils.loadGroups(req.app);
    const plans = utils.loadPlans(req.app);

    res.render('apisettings', {
        configPath: req.app.get('config_path'),
        safeApiId: safeApiId,
        api: thisApi,
        plugins: plugins,
        config: config,
        desc: apiDesc,
        swagger: apiSwagger,
        authMethods: authMethods,
        groups: groups,
        plans: plans
    });
});

router.post('/:apiId/api', function (req, res, next) {
    const body = utils.getJson(req.body);
    // console.log(JSON.stringify(body, null, 2));
    const apiId = req.params.apiId;
    const apis = utils.loadApis(req.app);
    const apiIndex = apis.apis.findIndex(a => a.id === apiId);
    apis.apis[apiIndex] = body.api;
    utils.saveApis(req.app, apis);

    const plugins = pluginUtils.makePluginsArray(body.plugins);
    const config = body.config;

    const kongConfig = {
        api: config.api,
        plugins: plugins
    };
    utils.saveApiConfig(req.app, apiId, kongConfig);
    utils.saveApiDesc(req.app, apiId, body.desc);
    let swagger = '';
    let message = 'OK';
    try {
        swagger = JSON.parse(body.swagger);
    } catch (err) {
        // If we ran into trouble, we'll try YAML
        try {
            swagger = yaml.safeLoad(body.swagger);
        } catch (err) {
            // OK, not good, we'll store as is and return a message
            swagger = body.swagger;
            message = 'The Swagger content is neither valid JSON not valid YAML; the content will not render in the Swagger UI component.';
        }
    }
    // Whatever we had, let's store it.
    utils.saveSwagger(req.app, apiId, swagger);
    res.json({ message: message });
});

/*
router.get('/:apiId', function (req, res, next) {
    var apiId = req.params.apiId;
    var config = utils.loadApiConfig(req.app, apiId);
    var envDict = utils.loadEnvDict(req.app);
    //utils.mixinEnv(config.api, envVars);
    utils.mixinEnv(config.api, envDict);
    var apis = {};
    var safeApiId = utils.makeSafeId(apiId);
    apis[safeApiId] = { api: config.api };
    var plugins = pluginUtils.makeViewModel(config.plugins);
    console.log(JSON.stringify(plugins, null, 2));
    res.render('apiconfig',
        {
            configPath: req.app.get('config_path'),
            apiId: apiId,
            safeApiId: safeApiId,
            apis: apis,
            plugins: plugins
        });
});
*/

// router.post('/:apiId', function (req, res, next) {
//     const apiId = req.params.apiId;
//     const redirect = req.body.redirect;
//     const safeApiId = apiId.replace(/\-/g, '');

//     const envVars = utils.loadEnvDict(req.app);

//     const body = utils.jsonifyBody(req.body);

//     const plugins = pluginUtils.makePluginsArray(body.plugins);
//     //console.log(JSON.stringify(plugins, null, 2));

//     const config = {
//         api: body.apis[safeApiId].api,
//         plugins: plugins
//     };
//     config.api.strip_uri = (!config.api.strip_uri) ? false : config.api.strip_uri;
//     utils.mixoutEnv(config.api, envVars, 'PORTAL_APIS_' + safeApiId.toUpperCase());

//     utils.saveApiConfig(req.app, apiId, config);
//     utils.saveEnvDict(req.app, envVars, "default");

//     res.redirect(redirect);
// });

module.exports = router;
