/****************************************************************************
 * app.js
 * openacousticdevices.info
 * October 2019
 *****************************************************************************/

'use strict';

/* global document */

const electron = require('electron');
const dialog = electron.remote.dialog;

const fs = require('fs');
const path = require('path');
const electronLog = require('electron-log');

const firmwareInterface = require('./firmwareInterface.js');
const comms = require('./communication.js');

/* File size limits for local binary files */
const MAX_FILE_SIZE = 256 * 1024 - 0x4000;
const MAX_FILE_SIZE_DESTRUCTIVE = 256 * 1024;

/* UI elements */
var fileButton = document.getElementById('file-button');

var destructiveCheckbox = document.getElementById('destructive-checkbox');

var flashButtonDownloaded = document.getElementById('flash-button0');
var flashButtonLocal = document.getElementById('flash-button1');

var statusDiv = document.getElementById('status-div');

var versionSelect = document.getElementById('version-select');
var downloadButton = document.getElementById('download-button');

/* Status set getStatus which enables/disables flash buttons */
var inFlashableState = false;

/* Frequency of status check */
var STATUS_TIMEOUT_LENGTH = 500;

/* Counter for port opening attempts */
var portOpenReattempts = 0;
const MAX_PORT_OPEN_ATTEMPTS = 5;
const PORT_OPEN_ATTEMPT_DELAY = 500;

comms.setPortOpenAttemptsMax(MAX_PORT_OPEN_ATTEMPTS);

electronLog.transports.file.fileName = 'audiomoth_flash.log';
console.log('Writing log to: ' + electronLog.transports.file.getFile().path);

electron.ipcRenderer.on('logfile', function () {

    var srcLogLocation, destLogLocation;

    srcLogLocation = electronLog.transports.file.getFile().path;

    destLogLocation = dialog.showSaveDialogSync({
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

        fs.copyFile(srcLogLocation, destLogLocation, function (err) {

            if (err) {

                electronLog.log('Failed to save log: ');
                electronLog.err(err);

            }

        });

    }

});

/* Enable flash buttons based on whether or not the app and connected device are in a state which permits flashing */
function updateFlashButtonState () {

    flashButtonDownloaded.disabled = (!inFlashableState || !firmwareInterface.isSelectionDownloaded() || comms.isCommunicating());
    flashButtonLocal.disabled = (!inFlashableState || firmwareInterface.getLocalFirmwarePath() === '' || comms.isCommunicating());

}

versionSelect.addEventListener('change', updateFlashButtonState);
downloadButton.addEventListener('click', updateFlashButtonState);

/* Work out the status of a connected device */

async function getStatus (callback) {

    var msdPath, serialBootloader, statusText, instructionLink;

    /* Check if an MSD device can be found on the system */
    msdPath = await comms.getMsdPath();

    if (msdPath !== null) {

        inFlashableState = true;
        electron.ipcRenderer.send('status-app', comms.STATUS_USB_DRIVE_BOOTLOADER);
        callback(null, 'Found AudioMoth in flash mode with a USB drive bootloader.');
        return;

    }

    /* Check if a serial device matching AudioMoth IDs can be found */
    serialBootloader = await comms.isInBootloader();

    if (serialBootloader) {

        inFlashableState = true;
        electron.ipcRenderer.send('status-app', comms.STATUS_SERIAL_BOOTLOADER);
        callback(null, 'Found AudioMoth in flash mode with a serial bootloader.');
        return;

    }

    /* If a device is present but not in bootloader, query whether it supports switching from USB to bootloader with a message */
    comms.queryBootloaderSwitching(function (err, supportsBootloaderSwitching) {

        if (err) {

            /* If the message couldn't be sent, then the device is inaccessible */
            inFlashableState = false;
            electron.ipcRenderer.send('status-app', comms.STATUS_NO_AUDIOMOTH);
            callback(null, 'No AudioMoth found.<br>Make sure the USB cable is connected and the switch is in USB/OFF.');

        } else {

            /* If a device was found, regardless of bootloader switch support, request firmware information */
            comms.requestFirmwareVersion(function (versionErr, versionString) {

                comms.requestFirmwareDescription(function (descriptionErr, descriptionString) {

                    if (supportsBootloaderSwitching) {

                        statusText = '';

                        if (versionErr || descriptionErr) {

                            statusText = 'Found an AudioMoth with firmware which supports automatic flash mode switching installed.';

                        } else {

                            statusText = 'Found an AudioMoth with ' + descriptionString + ' (' + versionString + ') installed. ';
                            statusText += 'This supports automatic switching to flash mode.';

                        }

                        inFlashableState = true;
                        electron.ipcRenderer.send('status-app', comms.STATUS_AUDIOMOTH_AUTO);
                        callback(null, statusText);

                    } else {

                        /* Add link which opens instructions window */

                        if (versionErr || descriptionErr || versionString === '0.0.0') {

                            statusText = 'Found an AudioMoth with firmware which does not support automatic flash mode switching. ';
                            statusText += '<a href="javascript:;" id="instruction-link">Follow instructions to manually switch to flash mode</a>.';

                        } else {

                            statusText = 'Found an AudioMoth with ' + descriptionString + ' (' + versionString + ') installed. ';
                            statusText += '<a href="javascript:;" id="instruction-link">Follow instructions to manually switch to flash mode</a>.';

                        }

                        inFlashableState = false;
                        electron.ipcRenderer.send('status-app', comms.STATUS_AUDIOMOTH_MANUAL);
                        callback(null, statusText);

                        /* Add a listener to the newly created hyperlink which opens the instructions window */
                        instructionLink = document.getElementById('instruction-link');

                        if (instructionLink) {

                            instructionLink.addEventListener('click', function () {

                                electron.ipcRenderer.send('open-instructions');

                            });

                        }

                    }

                });

            });

        }

    });

}

/* Send message to main process, triggering the completion message in the progress window */

function displayCompleteMessage (message) {

    /* If no message is provided, use default */
    message = (!message) ? 'Firmware has been successfully updated.' : message;
    electron.ipcRenderer.send('set-bar-completed', message);

    electronLog.log('--- Firmware write complete ---');

}

/* Re-enable the status box when the progress window closes */

electron.ipcRenderer.on('flash-success', comms.stopCommunicating);

/* If a device is found in the serial bootloader, start firmware sending process */
async function serialWrite (firmwarePath, destructive, version, expectedCRC) {

    var portName, maxBlocks;

    electronLog.log('--- Starting serial write ---');

    /* Calculate max size of progress bar and start */
    maxBlocks = Math.ceil(fs.statSync(firmwarePath).size / comms.BLOCK_SIZE);

    electron.ipcRenderer.send('set-bar-serial-opening-port', portOpenReattempts);

    /* Next, attempt to flash using serial bootloader */
    portName = await comms.getAudioMothPortName();

    comms.openPort(portName, function () {

        /* Make process end rather than retry in case of port failure, mid-way through flashing */
        comms.setPortErrorCallback(function () {

            comms.failFlash();
            comms.stopCommunicating();

        });

        electronLog.log('Opened port to send ready query');

        fs.readFile(firmwarePath, function (err, contents) {

            if (err) {

                comms.displayError('Firmware binary cannot be read.', 'Redownload and try again.');
                comms.stopCommunicating();

            } else {

                comms.sendFirmware(contents, destructive, expectedCRC, displayCompleteMessage, version, maxBlocks);

            }

        });

    }, function () {

        electronLog.log('Closed port');

    }, function () {

        if (portOpenReattempts <= MAX_PORT_OPEN_ATTEMPTS) {

            electronLog.log('Reattempting to open port. Attempt', (portOpenReattempts + 1));

            setTimeout(function () {

                portOpenReattempts++;
                serialWrite(firmwarePath, destructive, version, expectedCRC);

            }, PORT_OPEN_ATTEMPT_DELAY * Math.pow(2, portOpenReattempts));

        } else {

            electronLog.log('Gave up trying to open port after', portOpenReattempts, 'failed attempts.');
            comms.displayError('Communication failure.', 'Could not connect to AudioMoth.\nReconnect device and flash again.');
            comms.stopCommunicating();

        }

    });

}

/* If a device is found in the MSD bootloader, start firmware sending process */

function msdWrite (firmwarePath, destructive, version) {

    /* Message main process to display flashing message in progress bar */
    electron.ipcRenderer.send('set-bar-flashing');

    /* The MSD bootloader doesn't support being overwritten, so cancel */
    if (destructive) {

        electron.ipcRenderer.send('set-bar-aborted');

        dialog.showMessageBox({
            type: 'error',
            icon: path.join(__dirname, '/icon-64.png'),
            title: 'Cannot overwrite bootloader.',
            buttons: ['OK'],
            message: 'You are trying to overwrite a USB drive bootloader. You cannot do this with this application.'
        });

        comms.stopCommunicating();
        return;

    }

    electronLog.log('--- Starting MSD write ---');

    /* Send version of firmware being written to main process */
    electron.ipcRenderer.send('set-bar-info', version);

    /* Flash using MSD bootloader */
    comms.uploadFirmwareToMsd(firmwarePath, function (msdErr) {

        if (msdErr) {

            electronLog.error('MSD upload failure');
            electronLog.error(msdErr);

            dialog.showMessageBox({
                type: 'error',
                icon: path.join(__dirname, '/icon-64.png'),
                title: 'Failed to upload firmware binary using USB drive bootloader.',
                buttons: ['OK'],
                message: msdErr.message
            });

            comms.stopCommunicating();

        }

    }, displayCompleteMessage);

}

/* Work out what type of flash is appropriate for the current device */

async function flashButtonOnClick (firmwarePath, destructive, version, expectedCRC) {

    var serialBootloader, msdPath;

    /* If the app is already communicating with the device, don't try overriding it */
    if (comms.isCommunicating()) {

        return;

    }

    comms.startCommunicating();

    /* Set status bar text and flash button state */
    statusDiv.innerHTML = 'Communicating with AudioMoth.';
    inFlashableState = false;
    updateFlashButtonState();

    /* Open progress bar */
    electron.ipcRenderer.send('start-bar');

    /* Check for MSD bootloader if device is already in bootloader */
    msdPath = await comms.getMsdPath();

    if (msdPath !== null) {

        msdWrite(firmwarePath, destructive, version);
        return;

    }

    portOpenReattempts = 0;

    /* Check for serial bootloader if device is already in bootloader */
    serialBootloader = await comms.isInBootloader();

    if (serialBootloader) {

        serialWrite(firmwarePath, destructive, version, expectedCRC);
        return;

    }

    /* If a device is present but not in bootloader, query whether it supports switching from USB to bootloader with a message */
    comms.queryBootloaderSwitching(function (err, supportsBootloaderSwitching) {

        if (err) {

            /* If the message couldn't be sent, then the device is inaccessible */
            electron.ipcRenderer.send('set-bar-aborted');
            comms.displayError('No AudioMoth found.', err.message);
            comms.stopCommunicating();

        } else {

            if (supportsBootloaderSwitching) {

                /* Switch device to bootloader */
                comms.requestBootloader(async function (bootloaderErr) {

                    if (bootloaderErr) {

                        electron.ipcRenderer.send('set-bar-aborted');
                        comms.displayError('Failed to switch to flash mode.', bootloaderErr.message);
                        comms.stopCommunicating();

                    } else {

                        /* Check for MSD bootloader again */
                        msdPath = await comms.getMsdPath();

                        if (msdPath !== null) {

                            /* Flash using MSD */
                            msdWrite(firmwarePath, destructive, version);
                            return;

                        }

                        /* Check for serial bootloader again */
                        serialBootloader = await comms.isInBootloader();

                        if (serialBootloader) {

                            /* Wait and then flash using serial communication */
                            setTimeout(function () {

                                serialWrite(firmwarePath, destructive, version, expectedCRC);

                            }, PORT_OPEN_ATTEMPT_DELAY);

                            return;

                        }

                        comms.displayError('Failed to connect to AudioMoth.', 'Could not switch device to flash mode.\nVerify connection and try again.');
                        comms.stopCommunicating();

                    }

                });

            }

        }

    });

}

/* Flash button on downloaded firmware tab */

flashButtonDownloaded.addEventListener('click', function () {

    var firmwarePath, version, expectedCRC;

    firmwarePath = firmwareInterface.getCurrentFirmwareDirectory();
    version = firmwareInterface.getSelectedFirmwareVersion();
    expectedCRC = firmwareInterface.getSelectedFirmwareCRC();

    /* Firmware downloaded from Github releases never includes a bootloader so a destructive write is never needed */
    flashButtonOnClick(firmwarePath, false, version, expectedCRC);

});

/* Flash button on local firmware tab */

flashButtonLocal.addEventListener('click', function () {

    var errorMessage, stats, maxSize, firmwarePath;

    errorMessage = '';

    /* Check the selected firmware binary can be used to flash */
    firmwarePath = firmwareInterface.getLocalFirmwarePath();

    if (!firmwarePath) {

        errorMessage = 'No binary file selected.';

    } else if (!fs.existsSync(firmwarePath)) {

        errorMessage = 'Could not find selected binary.';

    } else {

        /* Calculate firmware file size */
        stats = fs.statSync(firmwarePath);

        /* Max file size is larger for destructive writes as it includes the bootloader size */
        maxSize = destructiveCheckbox.checked ? MAX_FILE_SIZE_DESTRUCTIVE : MAX_FILE_SIZE;

        if (stats.size > maxSize) {

            errorMessage = 'Selected binary is too large.';

        }

    }

    if (errorMessage !== '') {

        comms.displayError(errorMessage, 'Select a valid file and try again.');
        firmwareInterface.updateFirmwareDirectoryDisplay('');
        return;

    }

    /* As the firmware can be any custom firmware, version number and CRC are not known before flashing */
    flashButtonOnClick(firmwareInterface.getLocalFirmwarePath(), destructiveCheckbox.checked);

});

/* File select button for local firmware files */

function selectBinary () {

    var isValid;

    dialog.showOpenDialog({
        title: 'Select firmware binary',
        nameFieldLabel: 'Binary file',
        multiSelections: false,
        filters: [{
            name: 'bin',
            extensions: ['bin']
        }]
    }, async function (filenames) {

        if (filenames) {

            /* Check if binary is a valid firmware file */
            isValid = await firmwareInterface.isFirmwareFile(filenames[0]);

            if (isValid) {

                firmwareInterface.updateFirmwareDirectoryDisplay(filenames[0]);

            } else {

                comms.displayError('Invalid binary', 'Chosen firmware binary is not valid AudioMoth firmware.\nSelect a different file and try again.');

            }

        }

    });

}

fileButton.addEventListener('click', selectBinary);

/* Loop which continuously works out the status of a connected device */

function updateStatusText () {

    /* Don't start a status update if the app is already communicating with the device */
    if (!comms.isCommunicating()) {

        getStatus(function (err, status) {

            if (!err && !comms.isCommunicating()) {

                statusDiv.innerHTML = status;
                updateFlashButtonState();

            }

        });

        setTimeout(updateStatusText, STATUS_TIMEOUT_LENGTH);

    } else {

        statusDiv.innerHTML = 'Communicating with AudioMoth.';
        inFlashableState = false;
        updateFlashButtonState();
        setTimeout(updateStatusText, STATUS_TIMEOUT_LENGTH);

    }

}

/* Prepare UI */

firmwareInterface.updateFirmwareDirectoryDisplay('');
updateStatusText();

/* Retrieve list of firmware releases from the OAD Github page */
firmwareInterface.getReleases(firmwareInterface.prepareUI);
