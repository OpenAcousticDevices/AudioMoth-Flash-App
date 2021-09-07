/****************************************************************************
 * main.js
 * openacousticdevices.info
 * October 2019
 *****************************************************************************/

'use strict';

const electron = require('electron');
const app = electron.app;
const ipcMain = electron.ipcMain;
const BrowserWindow = electron.BrowserWindow;
const Menu = electron.Menu;
const shell = electron.shell;

const path = require('path');
const fs = require('fs');

const electronDL = require('electron-dl');
const ProgressBar = require('electron-progressbar');

var serialFlashMax;
var restartTimeout;

/* First and last section of the bar are dedicated to connecting to the device/switching to bootloader and restarting after */
/* CONNECTION_PERCENTAGE_VALUE must equal MAX_PORT_OPEN_ATTEMPTS in app.js */
const CONNECTION_PERCENTAGE_VALUE = 5;
const READY_CHECK_PERCENTAGE_VALUE = 7;
const RESTART_PERCENTAGE_VALUE = 10;
const FLASH_PERCENTAGE_VALUE = 100 - CONNECTION_PERCENTAGE_VALUE - READY_CHECK_PERCENTAGE_VALUE - RESTART_PERCENTAGE_VALUE;

var firmwareDirectory = path.join(app.getPath('downloads'), 'AudioMothFirmware');

require('electron-debug')({
    showDevTools: true,
    devToolsMode: 'undocked'
});

var mainWindow, instructionsWindow, aboutWindow;

var flashProgressBar;

/* Progress bar functions */

ipcMain.on('set-bar-restarted', () => {

    console.log('Incrementing progress as restart process is complete.');

    if (flashProgressBar) {

        flashProgressBar.value = CONNECTION_PERCENTAGE_VALUE + READY_CHECK_PERCENTAGE_VALUE + FLASH_PERCENTAGE_VALUE + RESTART_PERCENTAGE_VALUE;

    }

});

ipcMain.on('set-bar-restart-progress', (event, val) => {

    if (flashProgressBar) {

        const percentageComplete = RESTART_PERCENTAGE_VALUE * (val / restartTimeout);
        flashProgressBar.value = CONNECTION_PERCENTAGE_VALUE + READY_CHECK_PERCENTAGE_VALUE + FLASH_PERCENTAGE_VALUE + percentageComplete;

    }

});

ipcMain.on('set-bar-restarting', (event, timeout) => {

    console.log('Displaying restart message on progress bar with timeout:', timeout);

    if (flashProgressBar) {

        flashProgressBar.detail = 'Restarting AudioMoth.';
        restartTimeout = timeout;
        flashProgressBar.value = CONNECTION_PERCENTAGE_VALUE + READY_CHECK_PERCENTAGE_VALUE + FLASH_PERCENTAGE_VALUE;

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

        flashProgressBar.value = CONNECTION_PERCENTAGE_VALUE + READY_CHECK_PERCENTAGE_VALUE;

    }

});

ipcMain.on('set-bar-msd-flash-progress', (event, val) => {

    if (flashProgressBar) {

        const percentageComplete = FLASH_PERCENTAGE_VALUE * (val / 100);
        flashProgressBar.value = percentageComplete + CONNECTION_PERCENTAGE_VALUE + READY_CHECK_PERCENTAGE_VALUE;

    }

});

ipcMain.on('set-bar-serial-flash-progress', (event, val) => {

    if (flashProgressBar) {

        const percentageComplete = FLASH_PERCENTAGE_VALUE * (val / serialFlashMax);
        flashProgressBar.value = percentageComplete + CONNECTION_PERCENTAGE_VALUE + READY_CHECK_PERCENTAGE_VALUE;

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

ipcMain.on('set-bar-serial-ready-check', (event, val) => {

    if (flashProgressBar) {

        flashProgressBar.detail = 'Checking device is ready to be flashed.';
        flashProgressBar.value = CONNECTION_PERCENTAGE_VALUE + val;

    }

});

ipcMain.on('set-bar-serial-opening-port', (event, val) => {

    if (flashProgressBar) {

        flashProgressBar.detail = 'Attempting to open port.';
        flashProgressBar.value = val;

    }

});

ipcMain.on('start-bar', () => {

    if (flashProgressBar) {

        return;

    }

    flashProgressBar = new ProgressBar({
        title: 'AudioMoth Flash App',
        text: 'Flashing AudioMoth...',
        detail: 'Switching to flash mode.',
        closeOnComplete: false,
        indeterminate: false,
        browserWindow: {
            parent: mainWindow,
            webPreferences: {
                nodeIntegration: true
            }
        },
        /* When a progress bar reaches 100, the value is locked. So to allow the bar to fill when updating the bootloader and then again for the flash, it fills to 100/101 initially. */
        maxValue: 101
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

    console.log(await electronDL.download(win, url, {
        filename: fileName,
        directory: directory,
        errorMessage: 'Unable to download firmware file ' + fileName + '!',
        onStarted: onDownloadStarted,
        onCancel: onDownloadCancel
    }));

});

function shrinkWindowHeight (windowHeight) {

    if (process.platform === 'darwin') {

        windowHeight -= 20;

    } else if (process.platform === 'linux') {

        windowHeight -= 20;

    }

    return windowHeight;

}

function openInstructionsWindow () {

    let iconLocation = '/build/icon.ico';

    if (process.platform === 'linux') {

        iconLocation = '/build/icon.png';

    }

    instructionsWindow = new BrowserWindow({
        title: 'Manually Switch To Flash Mode',
        width: 550,
        height: shrinkWindowHeight(630),
        fullscreenable: false,
        resizable: false,
        icon: path.join(__dirname, iconLocation),
        parent: mainWindow,
        webPreferences: {
            nodeIntegration: true
        }
    });

    instructionsWindow.setMenu(null);
    instructionsWindow.loadURL(path.join('file://', __dirname, '/instructions/instructions.html'));

    instructionsWindow.on('closed', () => {

        instructionsWindow = null;

    });

}

ipcMain.on('open-instructions', openInstructionsWindow);

function openAboutWindow () {

    let iconLocation = '/build/icon.ico';

    if (process.platform === 'linux') {

        iconLocation = '/build/icon.png';

    }

    aboutWindow = new BrowserWindow({
        width: 400,
        height: shrinkWindowHeight(340),
        title: 'About AudioMoth Flash App',
        resizable: false,
        fullscreenable: false,
        icon: path.join(__dirname, iconLocation),
        parent: mainWindow,
        webPreferences: {
            nodeIntegration: true
        }
    });

    aboutWindow.setMenu(null);
    aboutWindow.loadURL(path.join('file://', __dirname, '/about.html'));

    aboutWindow.on('closed', () => {

        aboutWindow = null;

    });

}

app.on('ready', () => {

    let iconLocation = '/build/icon.ico';

    if (process.platform === 'linux') {

        iconLocation = '/build/icon.png';

    }

    const windowHeight = shrinkWindowHeight(450);

    mainWindow = new BrowserWindow({
        width: 565,
        height: windowHeight,
        useContentSize: true,
        title: 'AudioMoth Flash App',
        icon: path.join(__dirname, iconLocation),
        resizable: false,
        fullscreenable: false,
        webPreferences: {
            nodeIntegration: true
        }
    });

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
            label: 'Open Downloads Folder',
            id: 'downloadFolder',
            accelerator: 'CommandOrControl+O',
            click: () => {

                if (fs.existsSync(firmwareDirectory)) {

                    shell.openItem(firmwareDirectory);

                }

            }
        }, {
            label: 'Show Manual Switch Instructions',
            accelerator: 'CommandOrControl+I',
            click: () => {

                if (!instructionsWindow) {

                    openInstructionsWindow();

                }

            }
        }, {
            type: 'checkbox',
            checked: false,
            label: 'Enable Bootloader Overwrite Option',
            click: () => {

                mainWindow.webContents.send('toggle-bootloader-overwrite');

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
        label: 'Help',
        submenu: [{
            label: 'About',
            click: () => {

                if (!aboutWindow) {

                    openAboutWindow();

                }

            }
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
