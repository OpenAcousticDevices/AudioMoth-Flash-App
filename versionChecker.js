/****************************************************************************
 * versionChecker.js
 * openacousticdevices.info
 * November 2020
 *****************************************************************************/

'use strict';

/* global XMLHttpRequest */

const electron = require('electron');

const pjson = require('./package.json');

/* Compare two semantic versions and return true if older */

function isOlderSemanticVersion (aVersion, bVersion) {

    let aVersionNum, bVersionNum;

    for (let i = 0; i < aVersion.length; i++) {

        aVersionNum = aVersion[i];
        bVersionNum = bVersion[i];

        if (aVersionNum > bVersionNum) {

            return false;

        } else if (aVersionNum < bVersionNum) {

            return true;

        }

    }

    return false;

}

/* Check current app version in package.json against latest version in repository's releases */

exports.checkLatestRelease = (callback) => {

    let response;

    /* Check for internet connection */

    if (!navigator.onLine) {

        response = {updateNeeded: false, error: 'No internet connection, failed to request app version information.'};
        callback(response);
        return;

    }

    const version = electron.remote.app.getVersion();

    /* Transform repository URL into release API URL */

    const repoGitURL = pjson.repository.url;
    let repoURL = repoGitURL.replace('.git', '/releases');
    repoURL = repoURL.replace('github.com', 'api.github.com/repos');

    const xmlHttp = new XMLHttpRequest();
    xmlHttp.open('GET', repoURL, true);

    xmlHttp.onload = () => {

        if (xmlHttp.status === 200) {

            const responseJson = JSON.parse(xmlHttp.responseText);

            const latestVersion = responseJson[0].tag_name;

            console.log('Comparing latest release (' + latestVersion + ') with currently installed version (' + version + ')');

            /* Compare current version in package.json to latest version pulled from Github */

            const updateNeeded = isOlderSemanticVersion(version, latestVersion);

            response = {updateNeeded: updateNeeded, latestVersion: updateNeeded ? latestVersion : version};
            callback(response);

        }

    };

    xmlHttp.onerror = () => {

        console.error('Failed to pull release information.');

        response = {updateNeeded: false, error: 'HTTP connection error, failed to request app version information.'};
        callback(response);

    };

    /* Send request */

    xmlHttp.send(null);

};
