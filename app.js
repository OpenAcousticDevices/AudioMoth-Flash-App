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
const versionChecker = require('./versionChecker.js');

/* File size limits for local binary files */
const MAX_FILE_SIZE = 256 * 1024 - 0x4000;
const MAX_FILE_SIZE_DESTRUCTIVE = 256 * 1024;

/* UI elements */
const fileButton = document.getElementById('file-button');

const destructiveCheckbox = document.getElementById('destructive-checkbox');

const flashButtonDownloaded = document.getElementById('flash-button0');
const flashButtonLocal = document.getElementById('flash-button1');

const statusDiv = document.getElementById('status-div');

const versionSelect = document.getElementById('version-select');
const downloadButton = document.getElementById('download-button');

const overwriteBootloaderDiv = document.getElementById('overwrite-bootloader-div');

/* Status set getStatus which enables/disables flash buttons */
var inFlashableState = false;

/* Frequency of status check */
const STATUS_TIMEOUT_LENGTH = 500;

/* Counter for port opening attempts */
var portOpenReattempts = 0;
const MAX_PORT_OPEN_ATTEMPTS = 5;
const PORT_OPEN_ATTEMPT_DELAY = 500;

/* Counter for bootloader version check attempts */
var bootloaderVersionReattempts = 0;
const MAX_BOOTLOADER_VERSION_ATTEMPTS = 5;
const BOOTLOADER_VERSION_ATTEMPT_DELAY = 500;

/* Function called when bootloader has successfully been updated */
var bootloaderUpdateCompleteCallback;

/* Flag indicating waiting for progress window to stop showing bootloader update success message */
var displayingBootloaderSuccess = false;

/* Build packed path to bootloader update file] */
var directory = path.join(__dirname, 'firmware');
const unpackedDirectory = directory.replace('app.asar', 'app.asar.unpacked');

if (fs.existsSync(directory)) {

    directory = unpackedDirectory;

}

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

/* Enable flash buttons based on whether or not the app and connected device are in a state which permits flashing */

function updateFlashButtonState () {

    flashButtonDownloaded.disabled = (!inFlashableState || !firmwareInterface.isSelectionDownloaded() || comms.isCommunicating());
    flashButtonLocal.disabled = (!inFlashableState || firmwareInterface.getLocalFirmwarePath() === '' || comms.isCommunicating());

}

versionSelect.addEventListener('change', updateFlashButtonState);
downloadButton.addEventListener('click', updateFlashButtonState);

/* Work out the status of a connected device */

async function getStatus (callback) {

    /* Check if an MSD device can be found on the system */
    const msdPath = await comms.getMsdPath();

    if (msdPath !== null) {

        inFlashableState = true;
        electron.ipcRenderer.send('status-app', comms.STATUS_USB_DRIVE_BOOTLOADER);
        callback(null, 'Found AudioMoth in flash mode with a USB drive bootloader.');
        return;

    }

    /* Check if a serial device matching AudioMoth IDs can be found */
    const serialBootloader = await comms.isInBootloader();

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

                    let statusText;

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
                        const instructionLink = document.getElementById('instruction-link');

                        if (instructionLink) {

                            instructionLink.addEventListener('click', () => {

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

function displayCompleteMessage () {

    electron.ipcRenderer.send('set-bar-completed');

    electronLog.log('--- Firmware write complete ---');

}

/* Re-enable the status box when the progress window closes */

electron.ipcRenderer.on('flash-success', comms.stopCommunicating);

/* Create string to display on progress bar during flashing */

function getInfoText (version) {

    let infoText = '';

    if (version) {

        infoText = 'Applying firmware version ' + version + ' to attached device.';

    } else {

        infoText = 'Applying firmware to attached device';

    }

    return infoText;

}

/* Open file and write contents to serial port */

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

            comms.displayError('Firmware binary cannot be read.', 'Redownload and try again.');
            comms.stopCommunicating();

        } else {

            comms.sendFirmware(contents, destructive, expectedCRC, successCallback, infoText, maxBlocks);

        }

    });

}

/* Open port, open file and write contents to that port */

async function openPortAndSerialWrite (firmwarePath, destructive, infoText, expectedCRC, successCallback) {

    electron.ipcRenderer.send('set-bar-serial-opening-port', portOpenReattempts);

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
            comms.displayError('Communication failure.', 'Could not connect to AudioMoth. Reconnect device and try again.');
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
            comms.displayError('Communication failure.', 'Could not connect to AudioMoth. Reconnect device and try again.');
            comms.stopCommunicating();
            portOpenReattempts = 0;

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
            title: 'Cannot overwrite bootloader',
            buttons: ['OK'],
            message: 'You are trying to overwrite a USB drive bootloader. You cannot do this with this application.'
        });

        comms.stopCommunicating();
        return;

    }

    electronLog.log('--- Starting MSD write ---');

    /* Send version of firmware being written to main process */
    electron.ipcRenderer.send('set-bar-info', getInfoText(version));

    /* Flash using MSD bootloader */
    comms.uploadFirmwareToMsd(firmwarePath, (msdErr) => {

        if (msdErr) {

            electronLog.error('MSD upload failure');
            electronLog.error(msdErr);

            dialog.showMessageBox({
                type: 'error',
                icon: path.join(__dirname, '/icon-64.png'),
                title: 'Failed to upload firmware binary using USB drive bootloader',
                buttons: ['OK'],
                message: msdErr.message
            });

            comms.stopCommunicating();

        }

    }, displayCompleteMessage);

}

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
            comms.displayError('Communication failure.', 'Could not connect to AudioMoth. Reconnect device and try again.');
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
                comms.displayError('Communication failure.', 'Could not connect to AudioMoth. Reconnect device and try again.');
                comms.stopCommunicating();
                portOpenReattempts = 0;

            }

        });

    }, 1000);

}

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
                comms.displayError('Communication failure.', err.message + ' Reconnect device and try again.');
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

                const infoText = 'Applying bootloader update to attached device.';

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

        const fileRegex = new RegExp(/(audiomoth)?\d.\d.\d\.bin/);

        const regexResult = fileRegex.exec(path.basename(firmwarePath.toLowerCase()));

        if (regexResult) {

            dialog.showMessageBox({
                type: 'error',
                icon: path.join(__dirname, '/icon-64.png'),
                title: 'Cannot overwrite bootloader',
                buttons: ['OK'],
                message: 'You are trying to overwrite the bootloader with a standard release of AudioMoth firmware. You cannot do this with this application.'
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

    /* Check for MSD bootloader if device is already in bootloader */
    let msdPath = await comms.getMsdPath();

    if (msdPath !== null) {

        msdWrite(firmwarePath, destructive, version);
        return;

    }

    portOpenReattempts = 0;

    /* Check for serial bootloader if device is already in bootloader */
    let serialBootloader = await comms.isInBootloader();

    if (serialBootloader) {

        openPortCheckBootloader(firmwarePath, destructive, version, expectedCRC);
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
                comms.requestBootloader(async (bootloaderErr) => {

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

                                openPortCheckBootloader(firmwarePath, destructive, version, expectedCRC);

                            }, PORT_OPEN_ATTEMPT_DELAY);

                            return;

                        }

                        comms.displayError('Failed to connect to AudioMoth.', 'Could not switch device to flash mode. Verify connection and try again.');
                        comms.stopCommunicating();

                    }

                });

            }

        }

    });

}

/* Flash button on downloaded firmware tab */

flashButtonDownloaded.addEventListener('click', async () => {

    const firmwarePath = firmwareInterface.getCurrentFirmwareDirectory();
    const version = firmwareInterface.getSelectedFirmwareVersion();
    const expectedCRC = firmwareInterface.getSelectedFirmwareCRC();

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

        errorMessage = 'Could not find selected binary.';

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

        comms.displayError(errorMessage, 'Select a valid file and try again.');
        firmwareInterface.updateFirmwareDirectoryDisplay('');
        return;

    }

    /* As the firmware can be any custom firmware, version number and CRC are not known before flashing */
    flashButtonOnClick(firmwareInterface.getLocalFirmwarePath(), destructiveCheckbox.checked);

});

/* File select button for local firmware files */

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

    if (filenames) {

        /* Check if binary is a valid firmware file */
        const isValid = await firmwareInterface.isFirmwareFile(filenames.filePaths[0]);

        if (isValid) {

            firmwareInterface.updateFirmwareDirectoryDisplay(filenames.filePaths[0]);

        } else {

            comms.displayError('Invalid binary', 'Chosen firmware binary is not valid AudioMoth firmware. Select a different file and try again.');

        }

    }

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

/* Check if the flash app needs to be updated */

electron.ipcRenderer.on('update-check', () => {

    versionChecker.checkLatestRelease(function (response) {

        if (response.error) {

            console.error(response.error);

            dialog.showMessageBox(electron.remote.getCurrentWindow(), {
                type: 'error',
                title: 'Failed to check for updates',
                message: response.error
            });

            return;

        }

        if (response.updateNeeded === false) {

            dialog.showMessageBox(electron.remote.getCurrentWindow(), {
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

electron.ipcRenderer.on('toggle-bootloader-overwrite', () => {

    overwriteBootloaderDiv.style.display = (overwriteBootloaderDiv.style.display === '') ? 'none' : '';

});

/* Prepare UI */

firmwareInterface.updateFirmwareDirectoryDisplay('');
updateStatusText();

/* Retrieve list of firmware releases from the OAD Github page */

firmwareInterface.getReleases(firmwareInterface.prepareUI);

destructiveCheckbox.addEventListener('change', () => {

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
