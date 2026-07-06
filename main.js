/****************************************************************************
 * main.js
 * openacousticdevices.info
 * October 2019
 *****************************************************************************/

'use strict';

/* global process, __dirname */

const {app, Menu, shell, ipcMain, BrowserWindow} = require('electron');
const remoteMain = require('@electron/remote/main');
remoteMain.initialize();

const electronDebug = require('electron-debug');

const path = require('path');
const fs = require('fs');

/* Firmware types supported by this app */
const FIRMWARE_BASIC = 0;
const FIRMWARE_MICROPHONE = 1;
const FIRMWARE_GPS = 2;

const electronDL = require('electron-dl');

let serialFlashMax;
let restartTimeout;

let currentFirmware = FIRMWARE_BASIC;

/* First and last section of the bar are dedicated to connecting to the device/switching to bootloader then clearing user data (if enabled) and restarting after */
const READY_CHECK_PERCENTAGE_VALUE = 7;
const USER_DATA_CLEAR_PERCENTAGE_VALUE = 5;
const RESTART_PERCENTAGE_VALUE = 10;
const FLASH_PERCENTAGE_VALUE = 100 - READY_CHECK_PERCENTAGE_VALUE - RESTART_PERCENTAGE_VALUE - USER_DATA_CLEAR_PERCENTAGE_VALUE;

const firmwareDirectory = path.join(app.getPath('downloads'), 'AudioMothFirmware');

let mainWindow, instructionsWindow, aboutWindow, progressBarWindow;
let allowProgressWindowClose = false;

const iconLocation = (process.platform === 'linux') ? '/build/icon.png' : '/build/icon.ico';
const standardWindowSettings = {
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, iconLocation),
    useContentSize: true,
    webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false
    }
};

/* Generate settings objects for windows and progress bars */

function generateSettings (width, height, title) {

    const uniqueSettings = {
        width,
        height,
        title
    };

    const settings = Object.assign({}, standardWindowSettings, uniqueSettings);
    settings.parent = mainWindow;

    return settings;

}

/* Progress bar functions */

function setProgressBarValue (newValue) {

    if (!progressBarWindow.isDestroyed()) {

        progressBarWindow.webContents.send('set-progress-bar-value', newValue);

    }

}

ipcMain.on('set-bar-clear-user-data-complete', () => {

    console.log('Incrementing progress as user data clearing is complete.');

    setProgressBarValue(progressBeforeClearUserData + USER_DATA_CLEAR_PERCENTAGE_VALUE);

});

ipcMain.on('set-bar-clearing-user-data-progress', (event, val) => {

    const percentageComplete = Math.min(val * USER_DATA_CLEAR_PERCENTAGE_VALUE, USER_DATA_CLEAR_PERCENTAGE_VALUE);

    setProgressBarValue(progressBeforeClearUserData + percentageComplete);

});

let progressBeforeClearUserData = 0;

ipcMain.on('set-bar-clearing-user-data', () => {

    console.log('Displaying clearing user data message on progress bar');

    if (!progressBarWindow.isDestroyed()) {

        progressBarWindow.webContents.send('set-progress-bar-detail', 'Clearing user data.');

        progressBeforeClearUserData = progressBarWindow.progressBarCurrentValue;

    }

});

ipcMain.on('set-bar-restarted', () => {

    console.log('Incrementing progress as restart process is complete.');

    setProgressBarValue(READY_CHECK_PERCENTAGE_VALUE + FLASH_PERCENTAGE_VALUE + USER_DATA_CLEAR_PERCENTAGE_VALUE + RESTART_PERCENTAGE_VALUE);

});

ipcMain.on('set-bar-restart-progress', (event, val) => {

    const percentageComplete = RESTART_PERCENTAGE_VALUE * (val / restartTimeout);
    setProgressBarValue(READY_CHECK_PERCENTAGE_VALUE + FLASH_PERCENTAGE_VALUE + USER_DATA_CLEAR_PERCENTAGE_VALUE + percentageComplete);

});

ipcMain.on('set-bar-restarting', (event, timeout) => {

    console.log('Displaying restart message on progress bar with timeout:', timeout);

    if (!progressBarWindow.isDestroyed()) {

        progressBarWindow.webContents.send('set-progress-bar-detail', 'Restarting AudioMoth.');
        restartTimeout = timeout;
        setProgressBarValue(READY_CHECK_PERCENTAGE_VALUE + FLASH_PERCENTAGE_VALUE + USER_DATA_CLEAR_PERCENTAGE_VALUE);

    }

});

ipcMain.on('set-bar-checking-bootloader', () => {

    if (!progressBarWindow.isDestroyed()) {

        progressBarWindow.webContents.send('set-progress-bar-detail', 'Checking if bootloader needs updating.');

    }

});

ipcMain.on('set-bar-flashing', () => {

    console.log('Incrementing progress as connection process is complete.');

    setProgressBarValue(READY_CHECK_PERCENTAGE_VALUE);

});

ipcMain.on('set-bar-serial-flash-progress', (event, val) => {

    const percentageComplete = FLASH_PERCENTAGE_VALUE * (val / serialFlashMax);
    setProgressBarValue(percentageComplete + READY_CHECK_PERCENTAGE_VALUE);

});

ipcMain.on('reset-bar', () => {

    setProgressBarValue(0);

});

ipcMain.on('set-bar-bootloader-update-completed', () => {

    console.log('Setting bar to completed. Waiting before start requested flash.');

    if (!progressBarWindow.isDestroyed()) {

        setProgressBarValue(100);

        progressBarWindow.webContents.send('set-progress-bar-detail', 'Bootloader update complete.');

        setTimeout(function () {

            mainWindow.webContents.send('bootloader-update-success');

        }, 3000);

    }

});

ipcMain.on('set-bar-completed', () => {

    console.log('Setting bar to completed. Waiting before closing progress bar window.');

    if (!progressBarWindow.isDestroyed()) {

        setProgressBarValue(100);

        progressBarWindow.webContents.send('set-progress-bar-detail', 'Firmware has been successfully updated.');

        setTimeout(function () {

            closeProgressBarWindow();

            mainWindow.webContents.send('flash-success');

        }, 3000);

    }

});

ipcMain.on('set-bar-aborted', () => {

    console.log('Aborting progress.');

    closeProgressBarWindow();

});

ipcMain.on('set-bar-info', (event, infoText, max) => {

    if (!progressBarWindow.isDestroyed()) {

        if (max) {

            console.log('Setting progress bar maximum:', max);
            serialFlashMax = max;

        }

        progressBarWindow.webContents.send('set-progress-bar-detail', infoText);

    }

});

ipcMain.on('set-bar-serial-ready-check', () => {

    if (!progressBarWindow.isDestroyed()) {

        progressBarWindow.webContents.send('set-progress-bar-detail', 'Checking if AudioMoth is ready to be flashed.');

    }

});

ipcMain.on('start-bar', (e) => {

    createProgressBar('AudioMoth Flash App', 'Flashing AudioMoth...', 'Switching to serial flash mode.', 100, () => {

        e.returnValue = true;

    });

});

/* Firmware download functions */

function onDownloadStarted (downloadItem) {

    downloadItem.once('done', (event, state) => {

        if (state === 'completed') {

            mainWindow.webContents.send('download-success');

        }

    });

    /* Timeout download */
    setTimeout(function () {

        try {

            downloadItem.cancel();

        } catch (error) {

            console.log('Download object has been completed and destroyed.');

        }

    }, 10000);

}

function onDownloadCancel () {

    mainWindow.webContents.send('download-failure');

}

ipcMain.on('download-item', async (event, {url, fileName, directory}) => {

    const win = mainWindow;

    try {

        await electronDL.download(win, url, {
            filename: fileName,
            directory,
            errorMessage: 'Unable to download firmware file ' + fileName + '!',
            onStarted: onDownloadStarted,
            onCancel: onDownloadCancel
        });

    } catch (err) {

        console.error('Unable to download firmware file:', err.message);

    }

});

function openInstructionsWindow () {

    if (instructionsWindow) {

        instructionsWindow.show();
        return;

    }

    let windowWidth = 550;
    let windowHeight = 600;

    if (process.platform === 'linux') {

        windowWidth = 545;
        windowHeight = 570;

    } else if (process.platform === 'darwin') {

        windowWidth = 545;
        windowHeight = 580;

    }

    const settings = generateSettings(windowWidth, windowHeight, 'Manually Switch To Serial Flash Mode');
    instructionsWindow = new BrowserWindow(settings);

    require('@electron/remote/main').enable(instructionsWindow.webContents);

    instructionsWindow.setMenu(null);
    instructionsWindow.loadFile('instructions/instructions.html');

    if (!app.isPackaged) {

        electronDebug.openDevTools(instructionsWindow);

    }

    instructionsWindow.webContents.on('dom-ready', () => {

        mainWindow.webContents.send('poll-night-mode');

    });

    instructionsWindow.on('close', (e) => {

        e.preventDefault();

        instructionsWindow.hide();

    });

}

ipcMain.on('open-instructions', openInstructionsWindow);

function openAboutWindow () {

    if (aboutWindow) {

        aboutWindow.show();
        return;

    }

    let windowWidth = 400;
    let windowHeight = 310;

    if (process.platform === 'linux') {

        windowWidth = 395;
        windowHeight = 310;

    } else if (process.platform === 'darwin') {

        windowWidth = 395;
        windowHeight = 310;

    }

    const settings = generateSettings(windowWidth, windowHeight, 'About AudioMoth Flash App');
    aboutWindow = new BrowserWindow(settings);

    require('@electron/remote/main').enable(aboutWindow.webContents);

    aboutWindow.setMenu(null);
    aboutWindow.loadFile('about.html');

    if (!app.isPackaged) {

        electronDebug.openDevTools(aboutWindow);

    }

    aboutWindow.webContents.on('dom-ready', () => {

        mainWindow.webContents.send('poll-night-mode');

    });

    aboutWindow.on('close', (e) => {

        e.preventDefault();

        aboutWindow.hide();

    });

    aboutWindow.webContents.on('dom-ready', () => {

        mainWindow.webContents.send('poll-night-mode');

    });

}

ipcMain.on('night-mode-poll-reply', (e, nightMode) => {

    if (aboutWindow) {

        aboutWindow.webContents.send('night-mode', nightMode);

    }

    if (instructionsWindow) {

        instructionsWindow.webContents.send('night-mode', nightMode);

    }

});

function toggleNightMode () {

    mainWindow.webContents.send('night-mode');

    if (aboutWindow) {

        aboutWindow.webContents.send('night-mode');

    }

    if (instructionsWindow) {

        instructionsWindow.webContents.send('night-mode');

    }

}

function changeFirmware (firmwareID) {

    currentFirmware = firmwareID;

    const menu = Menu.getApplicationMenu();

    const firmwareOptionCount = menu.getMenuItemById('firmware_menu').submenu.items.length;

    for (let i = 0; i < firmwareOptionCount; i++) {

        const menuItem = menu.getMenuItemById('firmware_' + i);

        menuItem.checked = i === firmwareID;

    }

    mainWindow.webContents.send('changed-firmware', firmwareID);

}

ipcMain.on('poll-current-firmware', (event) => {

    event.returnValue = currentFirmware;

});

app.on('ready', () => {

    let iconLocation = '/build/icon.ico';

    if (process.platform === 'linux') {

        iconLocation = '/build/icon.png';

    }

    let windowWidth = 565;
    let windowHeight = 400;

    if (process.platform === 'linux') {

        windowWidth = 560;
        windowHeight = 426;

    } else if (process.platform === 'darwin') {

        windowWidth = 560;
        windowHeight = 455;

    }

    mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        title: 'AudioMoth Flash App',
        icon: path.join(__dirname, iconLocation),
        resizable: false,
        fullscreenable: false,
        useContentSize: true,
        webPreferences: {
            enableRemoteModule: true,
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    // TODO: This line fixes this issue: https://github.com/electron/electron/issues/51465 Check to see if still broken
    mainWindow.setSize(windowWidth, windowHeight);

    const menuTemplate = [{
        label: 'File',
        submenu: [{
            type: 'checkbox',
            id: 'nightmode',
            label: 'Night Mode',
            accelerator: 'CommandOrControl+N',
            checked: false,
            click: toggleNightMode
        }, {
            label: 'Open Downloads Folder',
            id: 'downloadFolder',
            accelerator: 'CommandOrControl+O',
            click: () => {

                if (fs.existsSync(firmwareDirectory)) {

                    shell.openPath(firmwareDirectory);

                }

            }
        }, {
            label: 'Show Manual Switch Instructions',
            accelerator: 'CommandOrControl+I',
            click: openInstructionsWindow
        }, {
            type: 'separator'
        }, {
            type: 'checkbox',
            checked: false,
            label: 'Enable Overwrite Bootloader Option',
            click: () => {

                mainWindow.webContents.send('toggle-bootloader-overwrite');

            }
        }, {
            type: 'separator'
        }, {
            type: 'checkbox',
            checked: true,
            label: 'Clear User Data When Flashing',
            click: () => {

                mainWindow.webContents.send('toggle-clear-user-data');

            }
        }, {
            type: 'checkbox',
            checked: true,
            label: 'Use USB HID Flashing',
            click: () => {

                mainWindow.webContents.send('toggle-usb-hid-flashing');

            }
        }, {
            type: 'separator'
        }, {
            label: 'Quit',
            accelerator: 'CommandOrControl+Q',
            click: () => {

                app.quit();

            }
        }]
    }, {
        label: 'Firmware',
        id: 'firmware_menu',
        submenu: [{
            label: 'AudioMoth Firmware Basic',
            type: 'checkbox',
            id: 'firmware_0',
            checked: true,
            click: () => {

                changeFirmware(FIRMWARE_BASIC);

            }
        }, {
            label: 'AudioMoth USB Microphone',
            type: 'checkbox',
            id: 'firmware_1',
            checked: false,
            click: () => {

                changeFirmware(FIRMWARE_MICROPHONE);

            }
        }, {
            label: 'AudioMoth GPS Sync',
            type: 'checkbox',
            id: 'firmware_2',
            checked: false,
            click: () => {

                changeFirmware(FIRMWARE_GPS);

            }
        }]
    }, {
        label: 'Help',
        submenu: [{
            label: 'About',
            click: openAboutWindow
        }, {
            type: 'separator'
        }, {
            label: 'Save Log File',
            accelerator: 'CommandOrControl+L',
            click: () => {

                mainWindow.webContents.send('logfile');

            }
        }, {
            label: 'Clear Log File',
            click: () => {

                mainWindow.webContents.send('logfileClear');

            }
        }, {
            type: 'separator'
        }, {
            label: 'Check For Updates',
            click: () => {

                mainWindow.webContents.send('update-check');

            }
        }, {
            type: 'separator'
        }, {
            label: 'Open Acoustic Devices Website',
            click: () => {

                shell.openExternal('https://openacousticdevices.info');

            }
        }]
    }];

    const menu = Menu.buildFromTemplate(menuTemplate);

    Menu.setApplicationMenu(menu);

    require('@electron/remote/main').enable(mainWindow.webContents);

    mainWindow.loadFile('index.html');

    if (!app.isPackaged) {

        electronDebug.openDevTools(mainWindow);

    }

});

function createProgressBar (windowTitle, heading, detail, maxValue, onReady) {

    if (!progressBarWindow || progressBarWindow.isDestroyed()) {

        let windowWidth = 500;
        const windowHeight = 160;

        if (process.platform === 'linux') {

            windowWidth = 495;

        } else if (process.platform === 'darwin') {

            windowWidth = 495;

        }

        const settings = generateSettings(windowWidth, windowHeight, '');
        progressBarWindow = new BrowserWindow({
            ...settings,
            modal: true,
            parent: mainWindow
        });

        require('@electron/remote/main').enable(progressBarWindow.webContents);

        progressBarWindow.setMenu(null);
        progressBarWindow.loadFile('progressBar.html');

        if (!app.isPackaged) {

            electronDebug.openDevTools(progressBarWindow);

        }

        allowProgressWindowClose = false;

        progressBarWindow.on('close', (e) => {

            if (!allowProgressWindowClose) {

                e.preventDefault();

            }

        });

    } else {

        progressBarWindow.show();

    }

    progressBarWindow.webContents.once('dom-ready', () => {

        progressBarWindow.webContents.send('create-progress-bar', {
            windowTitle,
            heading,
            detail,
            maxValue
        });

        onReady();

    });

}

function closeProgressBarWindow () {

    if (!progressBarWindow.isDestroyed()) {

        allowProgressWindowClose = true;
        progressBarWindow.destroy();

    }

}

ipcMain.on('close-progress-bar', closeProgressBarWindow);

app.on('window-all-closed', () => {

    app.quit();

});

ipcMain.on('status-app', (event, status) => {

    if (instructionsWindow) {

        instructionsWindow.send('status-instructions', status);

    }

});

app.disableHardwareAcceleration();
