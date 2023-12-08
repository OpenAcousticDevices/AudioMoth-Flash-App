/****************************************************************************
 * fimrwareInterface.js
 * openacousticdevices.info
 * October 2019
 *****************************************************************************/

'use strict';

/* global XMLHttpRequest */

/* Firmware files open with a 32-bit address 0 which are valid if they fall between these two values */
const MIN_ADDRESS_0 = 536870912;
const MAX_ADDRESS_0 = 536903680;

const electron = require('electron');
const {dialog, app, Menu} = require('@electron/remote');

const fs = require('fs');
const path = require('path');
const showdown = require('showdown');
const electronLog = require('electron-log');

/* Parse line breaks as <br> */
showdown.setOption('simpleLineBreaks', true);

/* Directory where downloaded firmware is stored */
const firmwareDirectory = path.join(app.getPath('downloads'), 'AudioMothFirmware');
exports.firmwareDirectory = firmwareDirectory;

/* JSON file backing up all release information */
const releaseInformationPaths = [
    path.join(app.getPath('userData'), 'releases_basic.json'),
    path.join(app.getPath('userData'), 'releases_microphone.json'),
    path.join(app.getPath('userData'), 'releases_gps.json')
];

/* Location of selected local firmware file */
let localFirmwareDirectory = '';

/* UI elements */
const releaseDescriptionSpan = document.getElementById('release-description-span');
const versionSelect = document.getElementById('version-select');

const downloadButton = document.getElementById('download-button');

const flashButtonDownloaded = document.getElementById('flash-button0');
const flashButtonLocal = document.getElementById('flash-button1');

const downloadTab = document.getElementById('download-tab');
const localTab = document.getElementById('local-tab');

const downloadTabLink = document.getElementById('download-tab-link');
const localTabLink = document.getElementById('local-tab-link');

const fileLabel = document.getElementById('file-label');

/* The names of supported firmwares */
const FIRMWARE_NAMES = ['AudioMoth-Firmware-Basic', 'AudioMoth-USB-Microphone', 'AudioMoth-GPS-Sync'];

/* URLs of the release pages for each supported firmware */
const FIRMWARE_URLS = [
    'https://api.github.com/repos/OpenAcousticDevices/AudioMoth-Firmware-Basic/releases',
    'https://api.github.com/repos/OpenAcousticDevices/AudioMoth-USB-Microphone/releases',
    'https://api.github.com/repos/OpenAcousticDevices/AudioMoth-GPS-Sync/releases'];

/* Array of release information objects */
const releaseArrays = Array(FIRMWARE_NAMES.length).fill([]);

/* Request the ID of the current firmware being displayed */

function requestCurrentFirmwareID () {

    const currentFirmwareID = electron.ipcRenderer.sendSync('poll-current-firmware');

    return currentFirmwareID;

}

/* React to the firmware changing in the menu */

electron.ipcRenderer.on('changed-firmware', (e, fw) => {

    console.log('Firmware changed to: ', FIRMWARE_NAMES[fw]);

    getReleases(prepareUI);

});

/* Get release information for a given firmware */

function getReleaseInformation () {

    const firmwareID = requestCurrentFirmwareID();

    return releaseArrays[firmwareID];

}

function getFirmwareName () {

    const firmwareID = requestCurrentFirmwareID();
    return FIRMWARE_NAMES[firmwareID];

}

/* Retrieve a specific release information object */

function getRelease (index) {

    const releases = getReleaseInformation();

    if (index < releases.length && index >= 0) {

        return releases[index];

    } else {

        return null;

    }

}

exports.getRelease = getRelease;

/* Get the index of the currently selected firmware */

function getSelectedIndex () {

    return versionSelect.selectedIndex;

}

exports.getSelectedIndex = getSelectedIndex;

/* Get the version number of the currently selected firmware */

function getSelectedFirmwareVersion () {

    return getRelease(getSelectedIndex()).name;

}

exports.getSelectedFirmwareVersion = getSelectedFirmwareVersion;

/* Get the previously calculated CRC of the currently selected firmware */

function getSelectedFirmwareCRC () {

    const releaseBody = getRelease(getSelectedIndex()).body;

    const regex = /\*\*Flash CRC\*\*: [A-Z0-9]{4}/;
    const regexResult = regex.exec(releaseBody);
    const releaseCRC = regexResult[0].substr(regexResult[0].length - 4, 4);

    return releaseCRC;

}

exports.getSelectedFirmwareCRC = getSelectedFirmwareCRC;

/* Get the location of the currently selected firmware on the user's system */

function getCurrentFirmwareDirectory () {

    return path.join(firmwareDirectory, getFirmwareName() + '-' + getSelectedFirmwareVersion() + '.bin');

}

exports.getCurrentFirmwareDirectory = getCurrentFirmwareDirectory;

/* Fill release description box with information pulled from Github */

function fillDescription (i) {

    const releases = getReleaseInformation();

    const publishDate = new Date(releases[i].published_at);
    const day = (publishDate.getDate() > 9) ? publishDate.getDate() : '0' + publishDate.getDate();
    const monthNum = publishDate.getMonth() + 1;
    const month = (monthNum > 9) ? monthNum : '0' + monthNum;
    const publishDateString = day + '/' + month + '/' + publishDate.getFullYear();

    let desc = '</br><p><b>Firmware:</b> ' + getFirmwareName() + '</br>';
    desc += '<b>Version:</b> ' + releases[i].name + '</br>';
    desc += '<b>Date released:</b> ' + publishDateString + '</p>';
    desc += '<b>Changes:</b>';

    const converter = new showdown.Converter();
    desc += converter.makeHtml(releases[i].body);

    releaseDescriptionSpan.innerHTML = desc;

}

/* Fill release selection with known versions */

function fillVersionList () {

    const releases = getReleaseInformation();

    versionSelect.innerHTML = '';

    for (let i = 0; i < releases.length; i++) {

        const option = document.createElement('option');
        option.text = releases[i].name;
        versionSelect.add(option);

    }

}

/* Check whether or not a firmware version is present in the download folder */

function isDownloaded (index) {

    const firmwareID = requestCurrentFirmwareID();

    if (releaseArrays[firmwareID].length === 0) {

        return false;

    }

    const releases = getReleaseInformation();

    const fileName = getFirmwareName() + '-' + releases[index].name + '.bin';

    return fs.existsSync(path.join(firmwareDirectory, fileName));

}

/* Check if selected firmware has been downloaded */

exports.isSelectionDownloaded = () => {

    return isDownloaded(versionSelect.selectedIndex);

};

/* Update download button appearance based on whether or not it's been downloaded */

function updateDownloadButton (index) {

    if (isDownloaded(index)) {

        downloadButton.innerHTML = 'Downloaded';
        downloadButton.disabled = true;

    } else {

        downloadButton.innerHTML = 'Download';
        downloadButton.disabled = false;

    }

    updateFolderButton();

}

/* Get the path of the selected local firmware file */

exports.getLocalFirmwarePath = () => {

    return localFirmwareDirectory;

};

/* Verify the selected file is an AudioMoth firmware file */

function isFirmwareFile (directory) {

    return new Promise(function (resolve) {

        const contents = fs.readFileSync(directory);

        if (!contents) {

            resolve(false);

        }

        const array8 = new Uint8Array([contents[0], contents[1], contents[2], contents[3]]);
        const array32 = new Uint32Array(array8.buffer);
        const address0 = array32[0];

        console.log('Firmware address 0: ' + address0);

        /* The first bytes of all AudioMoth firmware follow this sequence of values */
        resolve(address0 >= MIN_ADDRESS_0 && address0 <= MAX_ADDRESS_0);

    });

}

exports.isFirmwareFile = isFirmwareFile;

/* Display the shortened version of the selected local file directory in the UI */

function updateFirmwareDirectoryDisplay (directory) {

    if (!directory) {

        fileLabel.innerHTML = 'No file selected.';

    } else {

        fileLabel.innerHTML = path.basename(directory);

    }

    localFirmwareDirectory = directory;

}

exports.updateFirmwareDirectoryDisplay = updateFirmwareDirectoryDisplay;

/* Enable or disable UI when downloading */

function setUIDisabled (setting) {

    versionSelect.disabled = setting;

}

/* Update UI when a new firmware version is selected */

versionSelect.addEventListener('change', () => {

    fillDescription(versionSelect.selectedIndex);
    updateDownloadButtonForSelectedFirmware();

});

/* Download a version of firmware from Github */

function downloadFirmware (index) {

    /* If the user's computer has no internet access */
    if (!navigator.onLine) {

        dialog.showMessageBox({
            type: 'error',
            icon: path.join(__dirname, '/icon-64.png'),
            title: 'No internet connection',
            buttons: ['OK'],
            message: 'Could not connect to the Open Acoustic Devices server to download the requested firmware.'
        });

        return;

    }

    /* Create firmware folder in user's download directory */
    if (!fs.existsSync(firmwareDirectory)) {

        fs.mkdirSync(firmwareDirectory);

        dialog.showMessageBox({
            type: 'info',
            icon: path.join(__dirname, '/icon-64.png'),
            title: 'Created firmware folder',
            buttons: ['OK'],
            message: 'Created folder to contain firmware at ' + firmwareDirectory
        });

    }

    updateFolderButton();

    const releases = getReleaseInformation();
    const firmwareName = getFirmwareName();

    const release = releases[index];
    const fileName = firmwareName + '-' + release.name + '.bin';
    const url = release.browser_download_url;

    downloadButton.innerHTML = 'Downloading';
    downloadButton.disabled = true;
    setUIDisabled(true);

    /* Send message to main process, instructing it to download the file at the given Github URL */
    electron.ipcRenderer.send('download-item', {
        url,
        fileName,
        directory: firmwareDirectory
    });

}

/* Download the selected firmware version from Github */

downloadButton.addEventListener('click', () => {

    downloadFirmware(versionSelect.selectedIndex);

});

/* If the firmware downloads successfully */

function downloadFirmwareSuccess () {

    updateDownloadButtonForSelectedFirmware();
    setUIDisabled(false);

}

electron.ipcRenderer.on('download-success', downloadFirmwareSuccess);

/* If the firmware download fails (likely due to lack of internet connection) */

function downloadFirmwareFailure () {

    dialog.showMessageBox({
        type: 'error',
        icon: path.join(__dirname, '/icon-64.png'),
        title: 'Download failed',
        buttons: ['OK'],
        message: 'Failed to download firmware file. Check connection and try again.'
    });

    updateDownloadButtonForSelectedFirmware();
    setUIDisabled(false);

}

electron.ipcRenderer.on('download-failure', downloadFirmwareFailure);

/* Update download button for selected firmware file */

function updateDownloadButtonForSelectedFirmware () {

    updateDownloadButton(versionSelect.selectedIndex);

}

/* Button to open download folder should be disabled if downloads folder doesn't exist */

function updateFolderButton () {

    Menu.getApplicationMenu().getMenuItemById('downloadFolder').enabled = fs.existsSync(firmwareDirectory);

}

/* Initialise UI */

function prepareUI () {

    fillVersionList();
    fillDescription(0);
    versionSelect.selectedIndex = 0;
    updateDownloadButton(0);
    updateFolderButton();

}

exports.prepareUI = prepareUI;

/* Attempt to load release data from previously created local file */

function loadLocalReleaseFile (err, data) {

    if (err) {

        dialog.showMessageBox({
            type: 'error',
            icon: path.join(__dirname, '/icon-64.png'),
            title: 'No local release information',
            buttons: ['OK'],
            message: 'Failed to load local release information. Connect to the internet and reopen application to download additional firmware.'
        });

        flashButtonDownloaded.disabled = true;
        downloadButton.disabled = true;

        downloadTab.classList.remove('active', 'show');
        downloadTabLink.classList.remove('active');
        downloadTabLink.disabled = true;
        downloadTabLink.style.color = 'grey';

        localTab.classList.add('active', 'show');
        localTabLink.classList.add('active');
        localTabLink.disabled = true;

    } else {

        const firmwareID = requestCurrentFirmwareID();

        releaseArrays[firmwareID] = JSON.parse(data);
        prepareUI();

    }

}

/* Display error message if remote release file could not be downloaded and then attempt to use a previously downloaded version (if it exists) */

function remoteReleaseFailure (err) {

    electronLog.error(err);

    dialog.showMessageBox({
        type: 'error',
        icon: path.join(__dirname, '/icon-64.png'),
        title: 'Connection error',
        buttons: ['OK'],
        message: 'Failed to download latest release list. Attempting to use local list instead.'
    });

    const firmwareID = requestCurrentFirmwareID();

    fs.readFile(releaseInformationPaths[firmwareID], loadLocalReleaseFile);

}

/* Sort JSON objects using semantic versioning */

function sortSemanticVersion (a, b) {

    const aVersion = a.name.split('.');
    const bVersion = b.name.split('.');

    let aVersionNum, bVersionNum;

    for (let i = 0; i < aVersion.length; i++) {

        aVersionNum = parseInt(aVersion[i]);
        bVersionNum = parseInt(bVersion[i]);

        if (aVersionNum > bVersionNum) {

            return -1;

        } else if (aVersionNum < bVersionNum) {

            return 1;

        }

    }

    return 0;

}

/* Attempt to pull release information from Github */

function getReleases (callback) {

    const firmwareID = requestCurrentFirmwareID();
    const url = FIRMWARE_URLS[firmwareID];

    if (!navigator.onLine) {

        remoteReleaseFailure('No internet connection!');
        return;

    }

    const xmlHttp = new XMLHttpRequest();
    xmlHttp.open('GET', url, true);

    xmlHttp.onload = () => {

        if (xmlHttp.status === 200) {

            const releases = getReleaseInformation();

            const responseJson = JSON.parse(xmlHttp.responseText);

            releases.length = 0;

            for (let i = 0; i < responseJson.length; i++) {

                releases.push({
                    name: responseJson[i].name,
                    published_at: responseJson[i].published_at,
                    body: responseJson[i].body,
                    browser_download_url: responseJson[i].assets[0].browser_download_url
                });

            }

            /* Sort by version number */
            releases.sort(sortSemanticVersion);

            /* Update local backup */
            fs.writeFileSync(releaseInformationPaths[firmwareID], JSON.stringify(releases));

            callback();

        }

    };

    xmlHttp.onerror = remoteReleaseFailure;

    xmlHttp.send(null);

}

exports.getReleases = getReleases;

/* Switch to downloaded firmware tab */

downloadTabLink.addEventListener('click', () => {

    flashButtonLocal.style.display = 'none';
    flashButtonDownloaded.style.display = '';

});

/* Switch to local firmware tab */

localTabLink.addEventListener('click', () => {

    flashButtonDownloaded.style.display = 'none';
    flashButtonLocal.style.display = '';

});
