/****************************************************************************
 * app.js
 * openacousticdevices.info
 * October 2019
 *****************************************************************************/

'use strict';

/* global document */

const electron = require('electron');
const {dialog, getCurrentWindow} = require('@electron/remote');

const fs = require('fs');
const path = require('path');
const electronLog = require('electron-log');

const firmwareInterface = require('./firmwareInterface.js');
const comms = require('./communication.js');
const versionChecker = require('./versionChecker.js');
const nightMode = require('./nightMode.js');

/* File size limits for local binary files */
const MAX_FILE_SIZE = 256 * 1024 - 0x4000;
const MAX_FILE_SIZE_DESTRUCTIVE = 256 * 1024;

const MILLISECONDS_IN_SECOND = 1000;

/* UI elements */
const downloadTabLink = document.getElementById('download-tab-link');
const localTabLink = document.getElementById('local-tab-link');

const TAB_DOWNLOAD = 0;
const TAB_LOCAL = 1;
let currentTab = TAB_DOWNLOAD;

const fileButton = document.getElementById('file-button');

const destructiveCheckbox = document.getElementById('destructive-checkbox');

const flashButtonDownloaded = document.getElementById('flash-button0');
const flashButtonLocal = document.getElementById('flash-button1');

const statusDiv = document.getElementById('status-div');

const versionSelect = document.getElementById('version-select');
const downloadButton = document.getElementById('download-button');

const overwriteBootloaderDiv = document.getElementById('overwrite-bootloader-div');

let deviceStatus = comms.STATUS_NO_AUDIOMOTH;

/* Status set getStatus which enables/disables flash buttons */
let inFlashableState = false;

let inSerialBootloader = false;

/* The names of supported firmware */
const FIRMWARE_NAMES = ['AudioMoth-Firmware-Basic', 'AudioMoth-USB-Microphone', 'AudioMoth-GPS-Sync'];

/* Is overwrite bootloader option available */
let overwriteBootloaderOptionEnabled = false;

/* Should the user data be cleared of configuration when flashing */
let clearUserDataEnabled = true;

/* Should the USB HID flashing be used to flash devices */
let useUSBHIDFlashing = true;

/* Counter for user data clear attempts */
let clearUserDataAttempts = 0;
const MAX_CLEAR_USER_DATA_ATTEMPTS = 5;

/* Counter for port opening attempts */
let portOpenReattempts = 0;
const MAX_PORT_OPEN_ATTEMPTS = 5;
const PORT_OPEN_ATTEMPT_DELAY = 500;

/* Counter for bootloader version check attempts */
let bootloaderVersionReattempts = 0;
const MAX_BOOTLOADER_VERSION_ATTEMPTS = 5;
const BOOTLOADER_VERSION_ATTEMPT_DELAY = 500;

/* Function called when bootloader has successfully been updated */
let bootloaderUpdateCompleteCallback;

/* Flag indicating waiting for progress window to stop showing bootloader update success message */
let displayingBootloaderSuccess = false;

/* Build packed path to bootloader update file] */
let directory = path.join(__dirname, 'firmware');
const unpackedDirectory = directory.replace('app.asar', 'app.asar.unpacked');

if (fs.existsSync(directory)) {

    directory = unpackedDirectory;

}

/* Current status object used to update information panel and flash button status */

let statusResult;

let supportsUSBHIDFlash = false;
let supportsBootloaderSwitching = false;
let firmwareVersion = [0, 0, 0];
let firmwareDescription = '';

const bootloaderUpdatePath = path.join(directory, 'audiomoth_bootloader_updater.bin');
const bootloaderCRC = 'A435';

electronLog.transports.file.fileName = 'audiomoth_flash.log';
electronLog.transports.file.maxSize = 3145728;
console.log('Writing log to: ' + electronLog.transports.file.getFile().path);

/* Menu button to open log file pressed */

electron.ipcRenderer.on('logfile', () => {

    const srcLogLocation = electronLog.transports.file.getFile().path;

    const destLogLocation = dialog.showSaveDialogSync({
        title: 'Save log',
        nameFieldLabel: 'Log location',
        defaultPath: electronLog.transports.file.fileName,
        filters: [{
            name: 'log',
            extensions: ['log']
        }]
    });

    if (destLogLocation) {

        electronLog.log('Saving log...');

        fs.copyFile(srcLogLocation, destLogLocation, (err) => {

            if (err) {

                electronLog.log('Failed to save log: ');
                electronLog.err(err);

            }

        });

    }

});

/**
 * Debug function used to print the current device status
 */
function printDeviceStatus () {

    switch (deviceStatus) {

    case comms.STATUS_AUDIOMOTH_AUTO:
        console.log('STATUS_AUDIOMOTH_AUTO');
        break;

    case comms.STATUS_AUDIOMOTH_MANUAL:
        console.log('STATUS_AUDIOMOTH_MANUAL');
        break;

    case comms.STATUS_AUDIOMOTH_USB:
        console.log('STATUS_AUDIOMOTH_USB');
        break;

    case comms.STATUS_NO_AUDIOMOTH:
        console.log('STATUS_NO_AUDIOMOTH');
        break;

    case comms.STATUS_SERIAL_BOOTLOADER:
        console.log('STATUS_SERIAL_BOOTLOADER');
        break;

    default:
        break;

    }

}

/**
 * Enable flash buttons based on whether or not the app and connected device are in a state which permits flashing
 */
function updateFlashButtonState () {

    flashButtonDownloaded.disabled = (!inFlashableState || !firmwareInterface.isSelectionDownloaded() || comms.isCommunicating());
    flashButtonLocal.disabled = (!inFlashableState || firmwareInterface.getLocalFirmwarePath() === '' || comms.isCommunicating());

}

versionSelect.addEventListener('change', updateFlashButtonState);
downloadButton.addEventListener('click', updateFlashButtonState);

function communicateDeviceStatus (newStatus) {

    deviceStatus = newStatus;
    electron.ipcRenderer.send('status-app', newStatus);

}

/**
 * Work out the status of a connected device
 * @param {function} callback Completion callback
 */
async function getStatus (callback) {

    inFlashableState = false;
    inSerialBootloader = false;

    /* Check if a serial device matching AudioMoth IDs can be found */
    const serialBootloader = await comms.isInBootloader();

    if (serialBootloader) {

        inFlashableState = true;
        inSerialBootloader = true;
        callback();
        return;

    }

    try {

        statusResult = await comms.getStatus();

        if (statusResult === null) {

            throw ('No AudioMoth found.');

        }

        callback();

    } catch (error) {

        callback();

    }

}

/**
 * Send message to main process, triggering the completion message in the progress window
 */
function displayCompleteMessage () {

    electron.ipcRenderer.send('set-bar-completed');

    electronLog.log('--- Firmware write complete ---');

}

/* Re-enable the status box when the progress window closes */
electron.ipcRenderer.on('flash-success', comms.stopCommunicating);

/**
 * Create string to display on progress bar during flashing
 * @param {string} version Version number as a string (x.x.x)
 * @returns String to display on progress bar
 */
function getInfoText (version) {

    let infoText = '';

    if (version) {

        infoText = 'Applying firmware version ' + version + ' to attached AudioMoth.';

    } else {

        infoText = 'Applying firmware to attached AudioMoth.';

    }

    return infoText;

}

/**
 * Clear the connected device of all user data (config settings)
 * @param {function} successCallback Success callback
 */
function clearUserData (successCallback) {

    if (clearUserDataAttempts < MAX_CLEAR_USER_DATA_ATTEMPTS) {

        clearUserDataAttempts++;

        electronLog.log('Attempting to clear user data. Attempt ' + clearUserDataAttempts);

        comms.startUserDataClear(() => {

            clearUserData(successCallback);

        }, () => {

            clearUserDataAttempts = 0;

            successCallback();

        });

    } else {

        electronLog.error('Failed to clear user data after ' + MAX_CLEAR_USER_DATA_ATTEMPTS + ' attempts.');

        comms.displayError('Flash failure', 'Failed to clear user data after ' + MAX_CLEAR_USER_DATA_ATTEMPTS + ' attempts. Detach and reattach your AudioMoth, and try again.');

        comms.stopCommunicating();

    }

}

/**
 * Open file and write contents to serial port
 * @param {string} firmwarePath Path to firmware
 * @param {boolean} destructive Whether or not the flash will overwrite the bootloader
 * @param {string} infoText Text to display on the loading bar window
 * @param {string} expectedCRC Expected CRC value. If resulting CRC doesn't match, the user will be warned
 * @param {function} successCallback Success callback
 */
function serialWrite (firmwarePath, destructive, infoText, expectedCRC, successCallback) {

    /* Calculate max size of progress bar and start */
    const maxBlocks = Math.ceil(fs.statSync(firmwarePath).size / comms.BLOCK_SIZE);

    /* Make process end rather than retry in case of port failure, mid-way through flashing */
    comms.setPortErrorCallback(function () {

        comms.failFlash();
        comms.stopCommunicating();

    });

    fs.readFile(firmwarePath, (err, contents) => {

        if (err) {

            comms.displayError('Flash failure', 'Firmware binary cannot be read. Download again and retry.');
            comms.stopCommunicating();

        } else {

            if (clearUserDataEnabled) {

                clearUserData(() => {

                    electronLog.log('Successfully cleared user data');

                    comms.sendFirmware(contents, destructive, expectedCRC, successCallback, infoText, maxBlocks);

                });

            } else {

                comms.sendFirmware(contents, destructive, expectedCRC, successCallback, infoText, maxBlocks);

            }

        }

    });

}

/**
 * Open port, open file and write contents to that port
 * @param {string} firmwarePath Path to firmware
 * @param {boolean} destructive Whether or not the flash will overwrite the bootloader
 * @param {string} infoText Text to display on the loading bar window
 * @param {string} expectedCRC Expected CRC value. If resulting CRC doesn't match, the user will be warned
 * @param {function} successCallback Success callback
 */
async function openPortAndSerialWrite (firmwarePath, destructive, infoText, expectedCRC, successCallback) {

    const portName = await comms.getAudioMothPortName();

    if (!portName) {

        if (portOpenReattempts <= MAX_PORT_OPEN_ATTEMPTS) {

            electronLog.log('Reattempting to get port name. Attempt', (portOpenReattempts + 1));

            setTimeout(function () {

                portOpenReattempts++;
                openPortAndSerialWrite(firmwarePath, destructive, infoText, expectedCRC, successCallback);

            }, PORT_OPEN_ATTEMPT_DELAY * Math.pow(2, portOpenReattempts));

        } else {

            electronLog.log('Gave up trying to open port after', portOpenReattempts, 'failed attempts.');
            comms.displayError('Communication failure', 'Could not connect to AudioMoth. Reconnect AudioMoth and try again.');
            comms.stopCommunicating();
            portOpenReattempts = 0;

        }

        return;

    }

    comms.openPort(portName, () => {

        serialWrite(firmwarePath, destructive, infoText, expectedCRC, successCallback);

    }, () => {

        electronLog.log('Closed port');

    }, () => {

        if (portOpenReattempts <= MAX_PORT_OPEN_ATTEMPTS) {

            electronLog.log('Reattempting to open port. Attempt', (portOpenReattempts + 1));

            setTimeout(function () {

                portOpenReattempts++;
                openPortAndSerialWrite(firmwarePath, destructive, infoText, expectedCRC, successCallback);

            }, PORT_OPEN_ATTEMPT_DELAY * Math.pow(2, portOpenReattempts));

        } else {

            electronLog.log('Gave up trying to open port after', portOpenReattempts, 'failed attempts.');
            comms.displayError('Communication failure', 'Could not connect to AudioMoth. Reconnect AudioMoth and try again.');
            comms.stopCommunicating();
            portOpenReattempts = 0;

        }

    });

}

/**
 * Open the port to the device, check bootloader version and then continue with flashing process
 * @param {string} firmwarePath Path to firmware
 * @param {boolean} destructive Whether or not the flash will overwrite the bootloader
 * @param {string} version Firmware version as a string (x.x.x)
 * @param {string} expectedCRC Expected CRC value. If resulting CRC doesn't match, the user will be warned
 */
async function openPortCheckBootloader (firmwarePath, destructive, version, expectedCRC) {

    const portName = await comms.getAudioMothPortName();

    if (!portName) {

        if (portOpenReattempts <= MAX_PORT_OPEN_ATTEMPTS) {

            electronLog.log('Reattempting to get port name to check bootloader version. Attempt', (portOpenReattempts + 1));

            setTimeout(function () {

                portOpenReattempts++;
                openPortCheckBootloader(firmwarePath, destructive, version, expectedCRC);

            }, PORT_OPEN_ATTEMPT_DELAY * Math.pow(2, portOpenReattempts));

        } else {

            electronLog.log('Gave up trying to open port to check bootloader after', portOpenReattempts, 'failed attempts.');
            comms.displayError('Communication failure', 'Could not connect to AudioMoth. Reconnect AudioMoth and try again.');
            comms.stopCommunicating();
            portOpenReattempts = 0;

        }

        return;

    }

    electron.ipcRenderer.send('set-bar-checking-bootloader');

    setTimeout(() => {

        comms.openPort(portName, () => {

            bootloaderVersionReattempts = 0;
            checkBootloaderThenSerialWrite(firmwarePath, destructive, version, expectedCRC);

        }, () => {

            electronLog.log('Closed port');

        }, () => {

            if (portOpenReattempts <= MAX_PORT_OPEN_ATTEMPTS) {

                electronLog.log('Reattempting to open port to check bootloader version. Attempt', (portOpenReattempts + 1));

                setTimeout(function () {

                    portOpenReattempts++;
                    openPortCheckBootloader(firmwarePath, destructive, version, expectedCRC);

                }, PORT_OPEN_ATTEMPT_DELAY * Math.pow(2, portOpenReattempts));

            } else {

                electronLog.log('Gave up trying to open port to check bootloader after', portOpenReattempts, 'failed attempts.');
                comms.displayError('Communication failure', 'Could not connect to AudioMoth. Reconnect AudioMoth and try again.');
                comms.stopCommunicating();
                portOpenReattempts = 0;

            }

        });

    }, 1000);

}

/**
 * Check if bootloader needs updating, update it if necessary and then start serial write
 * @param {string} firmwarePath Path to firmware
 * @param {boolean} destructive Whether or not the flash will overwrite the bootloader
 * @param {string} version Firmware version as a string (x.x.x)
 * @param {string} expectedCRC Expected CRC value. If resulting CRC doesn't match, the user will be warned
 */
async function checkBootloaderThenSerialWrite (firmwarePath, destructive, version, expectedCRC) {

    comms.requestBootloaderVersion((err, bootloaderVersion) => {

        if (err) {

            if (bootloaderVersionReattempts < MAX_BOOTLOADER_VERSION_ATTEMPTS) {

                electronLog.log('Reattempting to check bootloader version. Attempt', (bootloaderVersionReattempts + 1));

                setTimeout(function () {

                    bootloaderVersionReattempts++;
                    checkBootloaderThenSerialWrite(firmwarePath, destructive, version, expectedCRC);

                }, BOOTLOADER_VERSION_ATTEMPT_DELAY * Math.pow(2, bootloaderVersionReattempts));

            } else {

                electronLog.log('--- Gave up trying to check bootloader after', bootloaderVersionReattempts, 'failed attempts. ---');
                comms.displayError('Communication failure', err + ' Reconnect AudioMoth and try again.');
                comms.stopCommunicating();

            }
            return;

        }

        /* Check if bootloader is on a version which requires updating */

        if (bootloaderVersion === 1.01 || bootloaderVersion === 1.0) {

            electronLog.log('Bootloader needs updating from version ' + bootloaderVersion);

            const buttonIndex = dialog.showMessageBoxSync({
                type: 'warning',
                icon: path.join(__dirname, '/icon-64.png'),
                noLink: true,
                buttons: ['Continue', 'Cancel'],
                title: 'Update bootloader',
                message: 'The bootloader requires an update before being flashed. Current version: ' + bootloaderVersion
            });

            if (buttonIndex === 0) {

                /* Function to run when the bootloader update is a success */

                bootloaderUpdateCompleteCallback = () => {

                    electronLog.log('Resuming firmware flash.');

                    portOpenReattempts = 0;

                    electronLog.log('--- Starting serial write ---');

                    openPortAndSerialWrite(firmwarePath, destructive, getInfoText(version), expectedCRC, displayCompleteMessage);

                };

                /* Text which appears above progress bar while bootloader update is running */

                const infoText = 'Applying bootloader update to attached AudioMoth.';

                /* Wait a short period for port to close before reopening */

                setTimeout(() => {

                    electronLog.log('--- Starting bootloader update ---');

                    serialWrite(bootloaderUpdatePath, false, infoText, bootloaderCRC, () => {

                        displayingBootloaderSuccess = true;

                        /* Display success message to user */

                        electron.ipcRenderer.send('set-bar-bootloader-update-completed');

                        electronLog.log('--- Bootloader update complete ---');

                    });

                }, PORT_OPEN_ATTEMPT_DELAY);

            } else {

                comms.stopCommunicating();
                electron.ipcRenderer.send('set-bar-aborted');

                electronLog.log('--- Flash cancelled. User declined updating bootloader ---');

            }

        } else {

            /* If update isn't necessary, flash as usual after short delay */

            electronLog.log('Bootloader does not need updating from version ' + bootloaderVersion);

            setTimeout(() => {

                serialWrite(firmwarePath, destructive, getInfoText(version), expectedCRC, displayCompleteMessage);

            }, PORT_OPEN_ATTEMPT_DELAY);

        }

    });

}

/* Message sent when bootloader update has succeeded and message has been briefly shown to the user telling them this */

electron.ipcRenderer.on('bootloader-update-success', () => {

    if (displayingBootloaderSuccess) {

        displayingBootloaderSuccess = false;

        /* Reset the progress bar for the actual firmware flash */

        electron.ipcRenderer.send('reset-bar');

        /* Run the originally requested serial write */

        bootloaderUpdateCompleteCallback();

    }

});

/* Work out what type of flash is appropriate for the current device */

async function flashButtonOnClick (firmwarePath, destructive, version, expectedCRC) {

    /* If the app is already communicating with the device, don't try overriding it */
    if (comms.isCommunicating()) {

        return;

    }

    electronLog.log('--- Starting communication ---');

    comms.startCommunicating();

    /* Set status bar text and flash button state */
    statusDiv.innerHTML = 'Communicating with AudioMoth.';
    inFlashableState = false;
    updateFlashButtonState();

    /* Verify user really wants to overwrite the bootloader (if on downloaded pane, 'destructive' will always be false) */
    if (destructive) {

        const fileRegex = /(audiomoth-firmware-basic|audiomoth-usb-microphone|audiomoth-gps-sync)-\d+\.\d+\.\d+\.bin/;

        const regexResult = fileRegex.exec(path.basename(firmwarePath.toLowerCase()));

        if (regexResult) {

            dialog.showMessageBox({
                type: 'error',
                icon: path.join(__dirname, '/icon-64.png'),
                title: 'Cannot overwrite bootloader',
                buttons: ['Cancel'],
                message: 'This firmware version is intended to be installed alongside the bootloader. Click below to cancel the operation.'
            });

            electron.ipcRenderer.send('set-bar-aborted');
            comms.stopCommunicating();
            return;

        } else {

            const buttonIndex = dialog.showMessageBoxSync({
                type: 'warning',
                icon: path.join(__dirname, '/icon-64.png'),
                buttons: ['Yes', 'No'],
                title: 'Overwrite bootloader',
                message: 'You are about to overwrite the bootloader. This should only be done with specific versions of firmware. Are you sure you want to do this?'
            });

            if (buttonIndex !== 0) {

                electron.ipcRenderer.send('set-bar-aborted');
                comms.stopCommunicating();
                return;

            } else {

                electronLog.log('PERFORMING DESTRUCTIVE WRITE');

            }

        }

    }

    /* Open progress bar */
    electron.ipcRenderer.send('start-bar');

    const overwriteBootloaderEnabled = overwriteBootloaderOptionEnabled && destructiveCheckbox.checked;

    if (useUSBHIDFlashing) {

        if (!supportsUSBHIDFlash) {

            electronLog.error('USB HID flashing not supported by current AudioMoth. Switching to serial');

        } else if (overwriteBootloaderEnabled) {

            electronLog.error('USB HID flashing not supported when bootloader overwriting is enabled. Switching to serial');

        } else if (deviceStatus === comms.STATUS_SERIAL_BOOTLOADER) {

            electronLog.log('Device supports USB HID flashing but is already in the serial bootloader. Switching to serial');

        } else {

            const firmwareNameValid = /^.+\.bin/.test(firmwarePath);

            if (firmwareNameValid === false) {

                electron.ipcRenderer.send('set-bar-aborted');
                comms.displayError('Flash failure', 'Firmware is not a .BIN file.');
                comms.stopCommunicating();
                return;

            }

            comms.USBHIDFlash(firmwarePath, clearUserDataEnabled, expectedCRC, getInfoText(version), displayCompleteMessage, (err) => {

                electronLog.error(err);
                electron.ipcRenderer.send('set-bar-aborted');
                comms.displayError('Flash failure', 'An error occurred during flashing. Detach and reattach your AudioMoth, and try again.');
                comms.stopCommunicating();

            });

            return;

        }

    }

    electronLog.log('Flashing using serial flash...');

    portOpenReattempts = 0;

    /* Check for serial bootloader if device is already in bootloader */
    let serialBootloader = await comms.isInBootloader();

    if (serialBootloader) {

        openPortCheckBootloader(firmwarePath, destructive, version, expectedCRC);
        return;

    }

    if (supportsBootloaderSwitching) {

        /* Switch device to bootloader */
        comms.requestBootloader(async (bootloaderErr) => {

            if (bootloaderErr) {

                electron.ipcRenderer.send('set-bar-aborted');
                comms.displayError('Flash failure', 'Could not switch to serial flash mode. Detach and reattach your AudioMoth, and try again.');
                comms.stopCommunicating();

            } else {

                /* Check for serial bootloader again */
                serialBootloader = await comms.isInBootloader();

                if (serialBootloader) {

                    /* Wait and then flash using serial communication */
                    setTimeout(function () {

                        openPortCheckBootloader(firmwarePath, destructive, version, expectedCRC);

                    }, PORT_OPEN_ATTEMPT_DELAY);

                    return;

                }

                electron.ipcRenderer.send('set-bar-aborted');
                comms.displayError('Flash failure', 'Could not switch to serial flash mode. Detach and reattach your AudioMoth, and try again.');
                comms.stopCommunicating();

            }

        });

    }

}

/* Flash button on downloaded firmware tab */

flashButtonDownloaded.addEventListener('click', async () => {

    const currentFirmwareID = requestCurrentFirmwareID();

    electronLog.log('Attempting to apply firmware:', FIRMWARE_NAMES[currentFirmwareID]);

    const firmwarePath = firmwareInterface.getCurrentFirmwareDirectory(currentFirmwareID);
    const version = firmwareInterface.getSelectedFirmwareVersion(currentFirmwareID);
    const expectedCRC = firmwareInterface.getSelectedFirmwareCRC(currentFirmwareID);

    /* Firmware downloaded from Github releases never includes a bootloader so a destructive write is never needed */
    flashButtonOnClick(firmwarePath, false, version, expectedCRC);

});

/* Flash button on local firmware tab */

flashButtonLocal.addEventListener('click', () => {

    let errorMessage = '';

    /* Check the selected firmware binary can be used to flash */
    const firmwarePath = firmwareInterface.getLocalFirmwarePath();

    if (!firmwarePath) {

        errorMessage = 'No binary file selected.';

    } else if (!fs.existsSync(firmwarePath)) {

        errorMessage = 'Selected binary no longer exists.';

    } else {

        /* Calculate firmware file size */
        const stats = fs.statSync(firmwarePath);

        /* Max file size is larger for destructive writes as it includes the bootloader size */
        const maxSize = destructiveCheckbox.checked ? MAX_FILE_SIZE_DESTRUCTIVE : MAX_FILE_SIZE;

        if (stats.size > maxSize) {

            errorMessage = 'Selected binary is too large.';

        }

    }

    if (errorMessage !== '') {

        comms.displayError('Invalid binary', errorMessage + ' Select a valid file and try again.');
        firmwareInterface.updateFirmwareDirectoryDisplay('');
        return;

    }

    electronLog.log('Attempting to apply local firmware binary');

    /* As the firmware can be any custom firmware, version number and CRC are not known before flashing */
    flashButtonOnClick(firmwareInterface.getLocalFirmwarePath(), destructiveCheckbox.checked);

});

/**
 * File select button for local firmware files
 */
async function selectBinary () {

    const filenames = await dialog.showOpenDialog({
        title: 'Select firmware binary',
        nameFieldLabel: 'Binary file',
        multiSelections: false,
        filters: [{
            name: 'bin',
            extensions: ['bin']
        }]
    });

    if (filenames && !filenames.canceled) {

        /* Check if binary is a valid firmware file */
        const isValid = await firmwareInterface.isFirmwareFile(filenames.filePaths[0]);

        if (isValid) {

            firmwareInterface.updateFirmwareDirectoryDisplay(filenames.filePaths[0]);

        } else {

            comms.displayError('Invalid binary', 'Chosen firmware binary is not valid AudioMoth firmware. Select a different file and try again.');

        }

        updateStatusUI();

    }

}

fileButton.addEventListener('click', selectBinary);

/**
 * Update the information text using cached information and flash button state after a status request
 */
function updateStatusUI () {

    if (inSerialBootloader) {

        statusDiv.innerHTML = 'Found an AudioMoth in serial flash mode.';
        updateFlashButtonState();
        communicateDeviceStatus(comms.STATUS_SERIAL_BOOTLOADER);
        return;

    }

    if (statusResult === undefined || statusResult === null) {

        inFlashableState = false;
        statusDiv.innerHTML = 'No AudioMoth found.<br>Make sure the USB cable is connected and the switch is in USB/OFF.';
        updateFlashButtonState();
        communicateDeviceStatus(comms.STATUS_NO_AUDIOMOTH);
        return;

    }

    supportsUSBHIDFlash = statusResult.supportsUSBHIDFlash;
    supportsBootloaderSwitching = statusResult.supportsBootloaderSwitch;
    firmwareVersion = statusResult.firmwareVersion;
    firmwareDescription = statusResult.firmwareDescription;

    let statusText;

    if (supportsBootloaderSwitching) {

        statusText = 'Found an AudioMoth with ' + firmwareDescription + ' (' + firmwareVersion[0] + '.' + firmwareVersion[1] + '.' + firmwareVersion[2] + ') installed.<br>';

        if (overwriteBootloaderOptionEnabled && destructiveCheckbox.checked && currentTab === TAB_LOCAL) {

            statusText += 'This AudioMoth will automatically enter serial flash mode and overwrite the bootloader.';
            communicateDeviceStatus(comms.STATUS_AUDIOMOTH_AUTO);

        } else {

            if (supportsUSBHIDFlash && useUSBHIDFlashing) {

                statusText += 'This AudioMoth will use USB HID flashing.';
                communicateDeviceStatus(comms.STATUS_AUDIOMOTH_USB);

            } else {

                statusText += 'This AudioMoth will automatically enter serial flash mode.';
                communicateDeviceStatus(comms.STATUS_AUDIOMOTH_AUTO);

            }

        }

        inFlashableState = true;

        if (!comms.isCommunicating()) {

            statusDiv.innerHTML = statusText;
            updateFlashButtonState();

        }

    } else {

        /* Add link which opens instructions window */

        if ((firmwareVersion[0] === 0 && firmwareVersion[1] === 0 && firmwareVersion[2] === 0) || !firmwareDescription === '') {

            statusText = 'Found an AudioMoth.<br>';
            statusText += '<a href="javascript:;" id="instruction-link">Follow instructions to manually switch to serial flash mode</a>.';

        } else {

            statusText = 'Found an AudioMoth with ' + firmwareDescription + ' (' + firmwareVersion[0] + '.' + firmwareVersion[1] + '.' + firmwareVersion[2] + ') installed.<br>';
            statusText += '<a href="javascript:;" id="instruction-link">Follow instructions to manually switch to serial flash mode</a>.';

        }

        inFlashableState = false;
        communicateDeviceStatus(comms.STATUS_AUDIOMOTH_MANUAL);

        if (!comms.isCommunicating()) {

            statusDiv.innerHTML = statusText;
            updateFlashButtonState();

        }

        /* Add a listener to the newly created hyperlink which opens the instructions window */
        const instructionLink = document.getElementById('instruction-link');

        if (instructionLink) {

            instructionLink.addEventListener('click', () => {

                electron.ipcRenderer.send('open-instructions');

            });

        }

    }

}

/**
 * Loop which continuously works out the status of a connected device
 */
function updateStatusText () {

    const milliseconds = Date.now() % MILLISECONDS_IN_SECOND;
    let delay = MILLISECONDS_IN_SECOND / 2 - milliseconds;
    if (delay < 0) delay += MILLISECONDS_IN_SECOND;

    /* Don't start a status update if the app is already communicating with the device */
    if (!comms.isCommunicating()) {

        getStatus(updateStatusUI);

        setTimeout(updateStatusText, delay);

    } else {

        statusDiv.innerHTML = 'Communicating with AudioMoth.';
        inFlashableState = false;
        updateFlashButtonState();
        setTimeout(updateStatusText, delay);

    }

}

/* Check if the flash app needs to be updated */

electron.ipcRenderer.on('update-check', () => {

    versionChecker.checkLatestRelease(function (response) {

        if (response.error) {

            console.error(response.error);

            dialog.showMessageBox(getCurrentWindow(), {
                type: 'error',
                title: 'Failed to check for updates',
                message: response.error
            });

            return;

        }

        if (response.updateNeeded === false) {

            dialog.showMessageBox(getCurrentWindow(), {
                type: 'info',
                title: 'Update not needed',
                message: 'Your app is on the latest version (' + response.latestVersion + ').'
            });

            return;

        }

        const buttonIndex = dialog.showMessageBoxSync({
            type: 'warning',
            buttons: ['Yes', 'No'],
            title: 'Download newer version',
            message: 'A newer version of this app is available (' + response.latestVersion + '), would you like to download it?'
        });

        if (buttonIndex === 0) {

            electron.shell.openExternal('https://www.openacousticdevices.info/applications');

        }

    });

});

/* Toggle whether or not write will be destructive (overwrite the bootloader) */

electron.ipcRenderer.on('toggle-bootloader-overwrite', () => {

    overwriteBootloaderOptionEnabled = !overwriteBootloaderOptionEnabled;

    overwriteBootloaderDiv.style.display = overwriteBootloaderOptionEnabled ? '' : 'none';

    if (!overwriteBootloaderOptionEnabled) {

        destructiveCheckbox.checked = false;

    }

    updateStatusUI();

});

/* Toggle clearing user data as part of a flash */

electron.ipcRenderer.on('toggle-clear-user-data', () => {

    clearUserDataEnabled = !clearUserDataEnabled;

    updateStatusUI();

});

/* Toggle USB HID flashing */

electron.ipcRenderer.on('toggle-usb-hid-flashing', () => {

    useUSBHIDFlashing = !useUSBHIDFlashing;

    updateStatusUI();

});

destructiveCheckbox.addEventListener('change', () => {

    updateStatusUI();

    if (!destructiveCheckbox.checked) {

        return;

    }

    const buttonIndex = dialog.showMessageBoxSync({
        type: 'warning',
        icon: path.join(__dirname, '/icon-64.png'),
        buttons: ['Yes', 'No'],
        title: 'Overwrite bootloader',
        message: 'Overwriting the bootloader with the wrong firmware can render your AudioMoth unusable. Are you sure you want to do this?'
    });

    if (buttonIndex !== 0) {

        destructiveCheckbox.checked = false;

    }

});

electron.ipcRenderer.on('night-mode', (e, nm) => {

    if (nm !== undefined) {

        nightMode.setNightMode(nm);

    } else {

        nightMode.toggle();

    }

});

electron.ipcRenderer.on('poll-night-mode', () => {

    electron.ipcRenderer.send('night-mode-poll-reply', nightMode.isEnabled());

});

/**
 * @returns Return the ID of the current firmware being displayed
 */
function requestCurrentFirmwareID () {

    const currentFirmwareID = electron.ipcRenderer.sendSync('poll-current-firmware');

    return currentFirmwareID;

}

downloadTabLink.addEventListener('click', () => {

    currentTab = TAB_DOWNLOAD;

    updateStatusUI();

});

localTabLink.addEventListener('click', () => {

    currentTab = TAB_LOCAL;

    updateStatusUI();

});

/* Prepare UI */

firmwareInterface.updateFirmwareDirectoryDisplay('');
updateStatusText();

/* Retrieve list of firmware releases from the OAD Github page */

firmwareInterface.getReleases(firmwareInterface.prepareUI);

firmwareInterface.setStatusUpdateFunction(updateStatusUI);
