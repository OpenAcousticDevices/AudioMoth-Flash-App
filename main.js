/****************************************************************************
 * main.js
 * openacousticdevices.info
 * October 2019
 *****************************************************************************/

'use strict';

const {app, Menu, shell, ipcMain, BrowserWindow} = require('electron');

require('@electron/remote/main').initialize();

const path = require('path');
const fs = require('fs');

/* Firmware types supported by this app */
const FIRMWARE_BASIC = 0;
const FIRMWARE_MICROPHONE = 1;
const FIRMWARE_GPS = 2;

const electronDL = require('electron-dl');
const ProgressBar = require('electron-progressbar');

let serialFlashMax;
let restartTimeout;

let currentFirmware = FIRMWARE_BASIC;

/* First and last section of the bar are dedicated to connecting to the device/switching to bootloader and restarting after */
const READY_CHECK_PERCENTAGE_VALUE = 7;
const RESTART_PERCENTAGE_VALUE = 10;
const FLASH_PERCENTAGE_VALUE = 100 - READY_CHECK_PERCENTAGE_VALUE - RESTART_PERCENTAGE_VALUE;

const firmwareDirectory = path.join(app.getPath('downloads'), 'AudioMothFirmware');

require('electron-debug')({
    showDevTools: true,
    devToolsMode: 'undocked'
});

let mainWindow, instructionsWindow, aboutWindow;

let flashProgressBar;

/* Progress bar functions */

ipcMain.on('set-bar-restarted', () => {

    console.log('Incrementing progress as restart process is complete.');

    if (flashProgressBar) {

        flashProgressBar.value = READY_CHECK_PERCENTAGE_VALUE + FLASH_PERCENTAGE_VALUE + RESTART_PERCENTAGE_VALUE;

    }

});

ipcMain.on('set-bar-restart-progress', (event, val) => {

    if (flashProgressBar) {

        const percentageComplete = RESTART_PERCENTAGE_VALUE * (val / restartTimeout);
        flashProgressBar.value = READY_CHECK_PERCENTAGE_VALUE + FLASH_PERCENTAGE_VALUE + percentageComplete;

    }

});

ipcMain.on('set-bar-restarting', (event, timeout) => {

    console.log('Displaying restart message on progress bar with timeout:', timeout);

    if (flashProgressBar) {

        flashProgressBar.detail = 'Restarting AudioMoth.';
        restartTimeout = timeout;
        flashProgressBar.value = READY_CHECK_PERCENTAGE_VALUE + FLASH_PERCENTAGE_VALUE;

    }

});

ipcMain.on('set-bar-checking-bootloader', () => {

    if (flashProgressBar) {

        flashProgressBar.detail = 'Checking if bootloader needs updating.';

    }

});

ipcMain.on('set-bar-flashing', () => {

    console.log('Incrementing progress as connection process is complete.');

    if (flashProgressBar) {

        flashProgressBar.value = READY_CHECK_PERCENTAGE_VALUE;

    }

});

ipcMain.on('set-bar-serial-flash-progress', (event, val) => {

    if (flashProgressBar) {

        const percentageComplete = FLASH_PERCENTAGE_VALUE * (val / serialFlashMax);
        flashProgressBar.value = percentageComplete + READY_CHECK_PERCENTAGE_VALUE;

    }

});

ipcMain.on('reset-bar', () => {

    if (!flashProgressBar) {

        return;

    }

    flashProgressBar.value = 0;

});

ipcMain.on('set-bar-bootloader-update-completed', () => {

    console.log('Setting bar to completed. Waiting before start requested flash.');

    if (flashProgressBar) {

        flashProgressBar.value = 100;
        flashProgressBar.detail = 'Bootloader update complete.';

        setTimeout(function () {

            mainWindow.webContents.send('bootloader-update-success');

        }, 3000);

    }

});

ipcMain.on('set-bar-completed', () => {

    console.log('Setting bar to completed. Waiting before closing progress bar window.');

    if (flashProgressBar) {

        flashProgressBar.setCompleted();
        flashProgressBar.detail = 'Firmware has been successfully updated.';

        setTimeout(function () {

            flashProgressBar.close();
            flashProgressBar = null;

            mainWindow.webContents.send('flash-success');

        }, 3000);

    }

});

ipcMain.on('set-bar-aborted', () => {

    console.log('Aborting progress.');

    if (flashProgressBar) {

        flashProgressBar.close();

    }

});

ipcMain.on('set-bar-info', (event, infoText, max) => {

    if (flashProgressBar) {

        if (max) {

            console.log('Setting progress bar maximum:', max);
            serialFlashMax = max;

        }

        flashProgressBar.detail = infoText;

    }

});

ipcMain.on('set-bar-serial-ready-check', () => {

    if (flashProgressBar) {

        flashProgressBar.detail = 'Checking if AudioMoth is ready to be flashed.';

    }

});

ipcMain.on('start-bar', () => {

    if (flashProgressBar) {

        return;

    }

    flashProgressBar = new ProgressBar({
        title: 'AudioMoth Flash App',
        text: 'Flashing AudioMoth...',
        detail: 'Switching to serial flash mode.',
        closeOnComplete: false,
        indeterminate: false,
        browserWindow: {
            parent: mainWindow,
            webPreferences: {
                enableRemoteModule: true,
                nodeIntegration: true,
                contextIsolation: false
            }
        },
        /* When a progress bar reaches 100, the value is locked. So to allow the bar to fill when updating the bootloader and then again for the flash, it fills to 100/101 initially. */
        maxValue: 101,
        height: process.platform === 'linux' ? 140 : 175
    });

    /* 'closable' option is not implemented on Linux, so block close action */
    flashProgressBar._window.on('close', (event) => {

        event.preventDefault();

    });

    console.log('Bar created.');

    flashProgressBar.on('aborted', () => {

        console.log('Flash bar aborted');
        flashProgressBar = null;

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

        console.error(err.message);

    }

});

function openInstructionsWindow () {

    if (instructionsWindow) {

        instructionsWindow.show();
        return;

    }

    let iconLocation = '/build/icon.ico';

    if (process.platform === 'linux') {

        iconLocation = '/build/icon.png';

    }

    let windowWidth = 550;
    let windowHeight = 600;

    if (process.platform === 'linux') {

        windowWidth = 545;
        windowHeight = 570;

    } else if (process.platform === 'darwin') {

        windowWidth = 545;
        windowHeight = 573;

    }

    instructionsWindow = new BrowserWindow({
        title: 'Manually Switch To Serial Flash Mode',
        width: windowWidth,
        height: windowHeight,
        fullscreenable: false,
        resizable: false,
        useContentSize: true,
        icon: path.join(__dirname, iconLocation),
        parent: mainWindow,
        webPreferences: {
            enableRemoteModule: true,
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    instructionsWindow.setMenu(null);
    instructionsWindow.loadURL(path.join('file://', __dirname, '/instructions/instructions.html'));

    require('@electron/remote/main').enable(instructionsWindow.webContents);

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

    let iconLocation = '/build/icon.ico';

    let windowWidth = 400;
    let windowHeight = 310;

    if (process.platform === 'linux') {

        windowWidth = 395;
        windowHeight = 310;

        iconLocation = '/build/icon.png';

    } else if (process.platform === 'darwin') {

        windowWidth = 395;
        windowHeight = 310;

    }

    aboutWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        title: 'About AudioMoth Flash App',
        resizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        useContentSize: true,
        icon: path.join(__dirname, iconLocation),
        parent: mainWindow,
        webPreferences: {
            enableRemoteModule: true,
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    aboutWindow.setMenu(null);
    aboutWindow.loadURL(path.join('file://', __dirname, '/about.html'));

    require('@electron/remote/main').enable(aboutWindow.webContents);

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
    let windowHeight = 450;

    if (process.platform === 'linux') {

        windowWidth = 560;
        windowHeight = 426;

    } else if (process.platform === 'darwin') {

        windowWidth = 560;
        windowHeight = 428;

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

    require('@electron/remote/main').enable(mainWindow.webContents);

    mainWindow.on('restore', () => {

        /* When minimised and restored, Windows platforms alter the BrowserWindow such that the height no longer includes the menu bar */
        /* This resize cannot be blocked so this fix resizes it, taking into account the menu change */
        if (process.platform === 'win32') {

            mainWindow.setSize(565, windowHeight + 40);

        }

    });

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
            label: 'Save Log File',
            accelerator: 'CommandOrControl+L',
            click: () => {

                mainWindow.webContents.send('logfile');

            }
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

    mainWindow.loadURL(path.join('file://', __dirname, '/index.html'));

});

app.on('window-all-closed', () => {

    app.quit();

});

ipcMain.on('status-app', (event, status) => {

    if (instructionsWindow) {

        instructionsWindow.send('status-instructions', status);

    }

});

app.disableHardwareAcceleration();
