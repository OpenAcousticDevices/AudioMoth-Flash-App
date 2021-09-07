/****************************************************************************
 * app.js
 * openacousticdevices.info
 * October 2019
 *****************************************************************************/

'use strict';

const electron = require('electron');
const dialog = electron.remote.dialog;

const audiomoth = require('audiomoth-hid');

const SerialPort = require('serialport');
const ByteLength = SerialPort.parsers.ByteLength;
const drivelist = require('drivelist');
const fs = require('fs');
const path = require('path');
const electronLog = require('electron-log');

/* Timeout to close port if message is sent and no response is received */
const PORT_TIMEOUT_LENGTH = 1500;

/* Counter for ready checks */
const MAX_READY_CHECK_COUNT = 7;
var readyCheckCount;
const READY_CHECK_DELAY_LENGTH = 100;

/* Timeout to wait for a switch to bootloader mode after the message is sent */
const BOOTLOADER_CHECK_MAX_TIMEOUT_LENGTH = 10000;
const BOOTLOADER_CHECK_TIMEOUT_LENGTH = 100;
var bootloaderCheckTimeout;
var bootloaderCheckTimedOut = false;

/* Timeout to wait for a reset after a serial flash */
const SERIAL_RESET_TIMEOUT_LENGTH = 7500;
const SERIAL_RESET_CHECK_TIMEOUT_LENGTH = 100;

/* Timeout to wait for a reset after an MSD flash */
const MSD_RESET_TIMEOUT_LENGTH = 5000;
const MSD_RESET_CHECK_TIMEOUT_LENGTH = 100;
var msdCheckTimeout;
var msdFinalTimeout;
var msdFinalTimedOut = false;

/* MSD flash progress timer. Total animation time = MSD_PROGRESS_TIMEOUT_LENGTH * MSD_MAX_PROGRESS */
const MSD_PROGRESS_TIMEOUT_LENGTH = 25;
const MSD_MAX_PROGRESS = 100;
var msdProgress;

/* Time spent resetting */
var resetTime;

/* Firmware binary file size limit when using MSD flashing */
const MAX_FILE_SIZE_MSD = 0x00034000;

/* Whether or not the app is in the process of communicating with a device (used to prevent spamming requests) */
var communicating = false;

/* Serial port through which AudioMoth communication is taking place */
var port;
/* Buffer object which extends as more bytes are received */
var queue;
/* Regex to be applied to the queue buffer when it's full */
var responseRegex;
/* Number of bytes expected as a response to a given message */
var responseExpectedLength;
/* Function which is run when correct response is received */
var completionFunction;

/* Callback called by openPort if failure occurs */
var portErrorCallback;

/* ID of timeout waiting for correct response */
var responseTimeout;
/* Whether or not a message request has already timed out */
var timedOut;

/* Timeout for attempting another ready check */
var readyTimeout;

var receiveComplete;

/* ID of timeout waiting for reset response */
var flashResetTimeout;

/* xmodem values: */
const SOH = 0x01;
const EOF = 0x04;
const ACK = 0x06;
const FILLER = 0xFF;

const BLOCK_SIZE = 128;
exports.BLOCK_SIZE = BLOCK_SIZE;
const MAX_REPEATS = 10;

/* Variables used to keep track of flash process */
var numberOfRepeats;
var blockNumber;
var lower = 0;
var upper = 0;

/* Array of buffers of length BLOCK_SIZE */
var splitBuffers;

/* Device statuses */
exports.STATUS_USB_DRIVE_BOOTLOADER = 0;
exports.STATUS_SERIAL_BOOTLOADER = 1;
exports.STATUS_NO_AUDIOMOTH = 2;
exports.STATUS_AUDIOMOTH_AUTO = 3;
exports.STATUS_AUDIOMOTH_MANUAL = 4;

/* Flag indicating the overall process has failed and shouldn't continue */
var flashFailed = false;

function closePort () {

    if (port.isOpen) {

        port.close();

    }

}

exports.closePort = closePort;

/* Generate Cyclical Redundancy Check code */

function crc16 (buffer) {

    let crc = 0x0;

    for (let i = 0; i < buffer.length; i++) {

        const byte = buffer[i];
        let code = (crc >>> 8) & 0xFF;

        code ^= byte & 0xFF;
        code ^= code >>> 4;
        crc = (crc << 8) & 0xFFFF;
        crc ^= code;
        code = (code << 5) & 0xFFFF;
        crc ^= code;
        code = (code << 7) & 0xFFFF;
        crc ^= code;

    }

    return crc;

}

/* Create error message window which blocks interaction with the main window */

function displayError (title, message) {

    electron.ipcRenderer.send('set-bar-aborted');

    dialog.showMessageBox({
        type: 'error',
        icon: path.join(__dirname, '/icon-64.png'),
        title: title,
        buttons: ['OK'],
        message: message
    });

}

exports.displayError = displayError;

/* Retrieve the path to the drive representing the AudioMoth MSD bootloader */

async function getMsdPath () {

    try {

        const drives = await drivelist.list();

        /* Iterate through all connected drives, matching description and drive capacity with known AudioMoth MSD values */
        for (let i = 0; i < drives.length; i++) {

            const drive = drives[i];

            /* If the device hasn't been mounted by the operating system yet, it can't be used */
            if (drive.description.includes('EFM32 MSD Device') && drive.size === 262144 && drive.mountpoints.length > 0) {

                return drive.mountpoints[0].path;

            }

        }

        return null;

    } catch (err) {

        electronLog.error(err);
        return null;

    }

}

exports.getMsdPath = getMsdPath;

/* Final check before MSD flash is complete. Wait for drive used for MSD to disappear, assuming that this is because the device has restarted */

async function checkMsdComplete (successCallback) {

    const msdPath = await getMsdPath();

    electronLog.log('Checking drives');

    /* If the final timeout hasn't been cleared yet */
    if (!msdFinalTimedOut) {

        if (msdPath !== null) {

            msdCheckTimeout = setTimeout(function () {

                /* Send amount of time app has been waiting to main process to calculate progress */
                resetTime += MSD_RESET_CHECK_TIMEOUT_LENGTH;
                electron.ipcRenderer.send('set-bar-restart-progress', resetTime);

                checkMsdComplete(successCallback);

            }, MSD_RESET_CHECK_TIMEOUT_LENGTH);

        } else {

            clearTimeout(msdFinalTimeout);
            electron.ipcRenderer.send('set-bar-restarted');
            successCallback();

        }

    }

}

/* Animate the progress bar to show MSD flash progress to user */

function updateMsdProgress (completionCallback) {

    /* Each iteration, increment by 2% */
    msdProgress += 2;

    if (msdProgress >= MSD_MAX_PROGRESS) {

        completionCallback();
        return;

    }

    electron.ipcRenderer.send('set-bar-msd-flash-progress', msdProgress);

    setTimeout(function () {

        updateMsdProgress(completionCallback);

    }, MSD_PROGRESS_TIMEOUT_LENGTH);

}

/* Attempt to upload firmware to device using MSD bootloader */
/* failureCallback is called if either no MSD drive is found or copying fails. It should run the other flashing methods */

async function uploadFirmwareToMsd (path, failureCallback, successCallback) {

    /* Reset progress bar progress */
    msdProgress = 0;

    /* Check binary size will fit on device */
    const stats = fs.statSync(path);

    if (stats.size > MAX_FILE_SIZE_MSD) {

        failureCallback(new Error('Selected binary is too large for USB drive flashing.'));
        return;

    }

    /* Get the path of the MSD drive */
    let uploadPath = await getMsdPath();

    if (uploadPath === null) {

        failureCallback(new Error('Unable to find AudioMoth USB drive.'));
        return;

    }

    uploadPath = uploadPath + '/FIRMWARE.BIN';

    /* Copy firmware binary into MSD, starting flash process */
    fs.copyFile(path, uploadPath, (err) => {

        if (err) {

            electron.ipcRenderer.send('set-bar-aborted');
            failureCallback(err);

        } else {

            electronLog.log('Successfully wrote firmware to MSD bootloader');

            updateMsdProgress(function () {

                electronLog.log('Waiting for restart');

                electron.ipcRenderer.send('set-bar-restarting', MSD_RESET_TIMEOUT_LENGTH);
                msdFinalTimedOut = false;

                /* Reset progress bar progress for reset timer */
                resetTime = 0;

                /* MSD bootloader will trigger a restart after being flashed */
                /* Wait for this restart to happen then confirm flash completion */
                checkMsdComplete(successCallback);

                /* If the device never disappears, the flash process was not successful as no restart occurred */
                msdFinalTimeout = setTimeout(function () {

                    msdFinalTimedOut = true;
                    clearTimeout(msdCheckTimeout);
                    electron.ipcRenderer.send('set-bar-aborted');
                    failureCallback(new Error('Device failed to restart after flashing using USB drive bootloader. Switch to USB/OFF, detach and reattach your device, and try again.'));

                }, MSD_RESET_TIMEOUT_LENGTH);

            });

        }

    });

}

exports.uploadFirmwareToMsd = uploadFirmwareToMsd;

/* Check all serial ports and return port name if AudioMoth is found */

async function getAudioMothPortName () {

    const ports = await SerialPort.list();

    for (let i = 0; i < ports.length; i += 1) {

        const p = ports[i];

        let vid = p.vendorId;
        const pid = p.productId;
        const path = p.path;

        if (vid !== undefined && pid !== undefined && path !== undefined) {

            vid = vid.toUpperCase();

            /* Vendor ID varies based on when the AudioMoth was manufactured */
            if ((vid === '10C4' || vid === '2544') && pid === '0003') {

                return path;

            }

        }

    }

    return false;

}

exports.getAudioMothPortName = getAudioMothPortName;

/* Verify the device is now in the bootloader */

async function checkBootloaderSwitch (callback) {

    /* Check for serial bootloader */
    const deviceFound = await isInBootloader();

    if (deviceFound) {

        clearTimeout(bootloaderCheckTimeout);
        callback();

    } else {

        /* Check for MSD bootloader */
        const msdPath = await getMsdPath();
        const msdFound = msdPath !== null;

        if (msdFound) {

            clearTimeout(bootloaderCheckTimeout);
            callback();

        } else {

            if (!bootloaderCheckTimedOut) {

                setTimeout(function () {

                    checkBootloaderSwitch(callback);

                }, BOOTLOADER_CHECK_TIMEOUT_LENGTH);

            }

        }

    }

}

/* Send message to AudioMoth in USB mode to switch to bootloader */

function requestBootloader (callback) {

    /* Send bootloader request packet and await confirmation message */
    audiomoth.switchToBootloader(function (err, packet) {

        if (err || packet === null) {

            callback(new Error('Failed to switch AudioMoth to flash mode. Switch to USB/OFF, detach and reattach your device, and try again.'));
            return;

        }

        /* Check for expected confirmation response */
        if (packet[0] === 0x0A && packet[1] === 0x01) {

            electronLog.log('Attached device switching to bootloader');

            /* Device will load bootloader, repeatedly check for the appearance of a serial or MSD bootloader until timeout */
            bootloaderCheckTimedOut = false;
            checkBootloaderSwitch(callback);

            bootloaderCheckTimeout = setTimeout(function () {

                bootloaderCheckTimedOut = true;
                callback(new Error('Failed to switch AudioMoth to flash mode. Switch to USB/OFF, detach and reattach your device, and try again.'));

            }, BOOTLOADER_CHECK_MAX_TIMEOUT_LENGTH);

        } else {

            callback(new Error('Attached device\'s firmware does not support bootloader switching over HID.'));

        }

    });

}

exports.requestBootloader = requestBootloader;

/* Function called whenever 1 byte of data is received */

function receive (data) {

    if (receiveComplete || timedOut || !port.isOpen) {

        return;

    }

    /* Add 1 byte of data to the queue */
    queue = Buffer.concat([queue, data]);

    /* When a given number of bytes have been added to the queue, check contents */
    if (queue.length >= responseExpectedLength) {

        clearTimeout(responseTimeout);
        timedOut = false;
        receiveComplete = true;

        /* Apply provided regex */
        const regexResult = responseRegex.exec(queue.toString('utf8'));

        /* Only return response if it matches the expected regex */
        if (regexResult) {

            switch (responseRegex.source) {

            case String.fromCharCode(ACK):
                electronLog.log('Received expected response: ACK');
                break;

            case String.fromCharCode(EOF):
                electronLog.log('Received expected response: EOF');
                break;

            default:
                electronLog.log('Received expected response: "' + regexResult[0] + '"');
                break;

            }

            completionFunction(null, regexResult[0]);

        } else {

            electronLog.error('Unexpected response: "' + queue.toString('hex') + '"');
            completionFunction(new Error('Unexpected response: "' + queue.toString('hex') + '"'));

        }

    }

}

/* Send buffer to AudioMoth on given port */

async function send (buffer, expectedLength, regex, callback) {

    if (flashFailed) {

        return;

    }

    if (!port.isOpen) {

        electronLog.error('Sending buffer failed. Port is closed');
        clearTimeout(responseTimeout);

        if (completionFunction) {

            completionFunction(new Error('Sending buffer failed. Port is closed'));

        }

        return;

    }

    receiveComplete = false;

    /* Set response expectations */
    responseExpectedLength = expectedLength;

    /* Set REGEX */
    responseRegex = regex;

    /* Set function which will be run after the right number of bytes have been received and the response matches responseRegex */
    completionFunction = callback;

    /* Clear buffer */
    queue = Buffer.alloc(0);

    if (buffer.length === 1) {

        if (buffer[0] === EOF) {

            electronLog.log('Writing data to port: EOF');

        } else {

            electronLog.log('Writing data to port: \'' + String.fromCharCode(buffer[0]) + '\'');

        }

    } else {

        electronLog.log('Writing data to port:', buffer.toString('hex'));

    }

    /* Send command */
    port.write(buffer, (err) => {

        electronLog.log('Write complete');

        if (err) {

            clearTimeout(responseTimeout);

        }

    });

    responseTimeout = setTimeout(function () {

        electronLog.error('Timed out waiting for response');

        timedOut = true;

        completionFunction(new Error('Timed out waiting for response'));

    }, PORT_TIMEOUT_LENGTH);

    timedOut = false;

}

exports.setPortErrorCallback = (callback) => {

    portErrorCallback = callback;

};

exports.failFlash = () => {

    displayError('Communication failure.', 'Could not connect to AudioMoth. Reconnect device and try again.');

    flashFailed = true;

};

/* Open a port with given name, calling each of the given callbacks when the port opens/closes */

function openPort (name, openCallback, closeCallback, errorCallback) {

    /* Clear buffer */
    queue = Buffer.alloc(0);

    /* Open a connection to the port at the given path */
    port = new SerialPort(name, {
        baudRate: 9600
    }, false);

    port.on('open', () => {

        openCallback();

    });

    /* Add functions to event listeners if they're provided */
    if (closeCallback) {

        port.on('close', closeCallback);

    }

    if (errorCallback) {

        portErrorCallback = errorCallback;

    }

    port.on('error', (err) => {

        electronLog.error(err);

        if (portErrorCallback) {

            portErrorCallback();

        }

    });

    /* Every time 1 byte is received, call receive(data) */
    const parser = port.pipe(new ByteLength({length: 1}));
    parser.on('data', receive);

}

exports.openPort = openPort;

/* Query AudioMoth as to whether it supports switching from USB mode to the bootloader in response to a packet */

function queryBootloaderSwitching (callback) {

    audiomoth.queryBootloader(function (err, supportsBootloaderSwitch) {

        if (err || supportsBootloaderSwitch === null) {

            callback(new Error('Could not connect to device to query whether it supports flash mode switching. Verify connection and try again.'));

        } else {

            callback(null, supportsBootloaderSwitch);

        }

    });

}

exports.queryBootloaderSwitching = queryBootloaderSwitching;

/* Request current firmware version. When response is received, run callback with string containing version number as the only argument */

function requestFirmwareVersion (callback) {

    audiomoth.getFirmwareVersion(function (err, versionArr) {

        if (err || versionArr === null) {

            callback(new Error('Could not connect to device to obtain firmware version. Verify connection and try again.'));

        } else {

            callback(null, versionArr[0] + '.' + versionArr[1] + '.' + versionArr[2]);

        }

    });

}

exports.requestFirmwareVersion = requestFirmwareVersion;

/* Request current firmware description. When response is received, run callback with string containing description assigned in firmware source */

function requestFirmwareDescription (callback) {

    audiomoth.getFirmwareDescription(function (err, description) {

        if (err) {

            callback(new Error('Could not connect to device to obtain firmware description. Verify connection and try again.'));

        } else {

            callback(null, description);

        }

    });

}

exports.requestFirmwareDescription = requestFirmwareDescription;

/* Attempt to retrieve the port name of a connected ID, if one is found return true, else return false */

async function isInBootloader () {

    /* Asynchronously obtain the port of the AudioMoth */
    const audioMothPortName = await getAudioMothPortName();

    return audioMothPortName !== false;

}

exports.isInBootloader = isInBootloader;

/* Return variable representing communication between the app and a device which prevents overlapping communication */

function isCommunicating () {

    return communicating;

}
exports.isCommunicating = isCommunicating;

function startCommunicating () {

    communicating = true;

}
exports.startCommunicating = startCommunicating;

/* Set communication flag to false and then close the port if it's currently open */

function stopCommunicating () {

    communicating = false;

    if (port.isOpen) {

        closePort();

    }

}
exports.stopCommunicating = stopCommunicating;

/* Request the CRC of the firmware currently on the AudioMoth */

function requestCRC (isDestructive, callback) {

    /* If the flash is destructive, then the CRC should take into account the bootloader as well as the firmware itself */
    const readType = isDestructive ? 'v' : 'c';

    const sendBuffer = Buffer.from(readType);
    const responseLength = 18;
    const regex = /CRC: 0000[A-Z0-9]{4}/;

    send(sendBuffer, responseLength, regex, callback);

}

/* Request the version of the bootloader currently installed on the AudioMoth */

function requestBootloaderVersion (callback) {

    const sendBuffer = Buffer.from('i');
    const responseLength = 54;
    const regex = /BOOTLOADER version [0-9]\.[0-9]{2}, Chip ID [0-9A-Z]{16}/;

    send(sendBuffer, responseLength, regex, (err, response) => {

        if (err) {

            callback(new Error('Unable to establish communication with bootloader.'));

        } else {

            const bootloaderVersion = parseFloat(response.substr(19, 23));
            callback(null, bootloaderVersion);

        }

    });

}

exports.requestBootloaderVersion = requestBootloaderVersion;

/* Animate progress as app waits for flashed device to reset */

async function serialRestartTimer (message, successCallback) {

    if (resetTime < SERIAL_RESET_TIMEOUT_LENGTH) {

        electron.ipcRenderer.send('set-bar-restart-progress', resetTime);

        setTimeout(function () {

            resetTime += SERIAL_RESET_CHECK_TIMEOUT_LENGTH;
            serialRestartTimer(message, successCallback);

        }, SERIAL_RESET_CHECK_TIMEOUT_LENGTH);

    } else {

        electron.ipcRenderer.send('set-bar-restarted');
        successCallback(message);

    }

}

function resetFailure (message) {

    electronLog.error('Reset failed, closing port');

    dialog.showMessageBox({
        type: 'warning',
        icon: path.join(__dirname, '/icon-64.png'),
        title: 'Flashing complete',
        buttons: ['OK'],
        message: message + ' Switch to USB/OFF, detach and reattach your device to verify new firmware version.'
    });

    electron.ipcRenderer.send('set-bar-aborted');

    stopCommunicating();

}

/* Send reset message to device then wait for the bootloader to disappear from serial port list */

function checkSerialComplete (message, successCallback) {

    /* Send full reset message */
    const sendBuffer = Buffer.from('r');
    const responseLength = 1;
    const regex = /r/;

    send(sendBuffer, responseLength, regex, (err, response) => {

        clearTimeout(flashResetTimeout);
        clearTimeout(responseTimeout);

        closePort();

        if (err) {

            resetFailure(message);
            return;

        }

        electronLog.log('Reset message sent, response: "' + response + '"');

        electronLog.log('Waiting for serial device to restart');

        /* Check device has reset */
        electron.ipcRenderer.send('set-bar-restarting', SERIAL_RESET_TIMEOUT_LENGTH);

        resetTime = 0;
        serialRestartTimer(message, successCallback);

    });

    /* If there's no response to the reset message */
    flashResetTimeout = setTimeout(function () {

        resetFailure(message);

    }, 5000);

}

/* Verify flash was successful by comparing new firmware CRC with previously calculated CRC */

function crcCheck (expectedCRC, isDestructive, successCallback) {

    requestCRC(isDestructive, (err, response) => {

        if (err) {

            displayError('Unable to verify success', 'Flash completed but success could not be verified. Switch to USB/OFF, detach and reattach your device, and try again.');
            electron.ipcRenderer.send('set-bar-aborted');
            stopCommunicating();

        } else {

            /* CRC message sent by bootloader is prepended with 'CRC:', so only the last 4 characters which actually contain the CRC are needed */
            const receivedCRC = response.substr(response.length - 4, 4);

            if (expectedCRC) {

                electronLog.log('Comparing CRCs');
                electronLog.log('Expected: ' + expectedCRC + ', Received: ' + receivedCRC);

                if (receivedCRC === expectedCRC) {

                    electronLog.log('Flash CRC was correct, resetting device');
                    checkSerialComplete('Firmware has been successfully updated.', successCallback);

                } else {

                    electronLog.error('Flash CRC was incorrect, ending communication');

                    let errorString = 'Flash failed, CRC did not match. ';
                    errorString += 'Expected ' + expectedCRC + ' but received ' + receivedCRC + '. ';
                    errorString += 'Reconnect device and try again.';
                    displayError('Incorrect CRC', errorString);
                    electron.ipcRenderer.send('set-bar-aborted');
                    stopCommunicating();

                }

            } else {

                checkSerialComplete('Firmware has been successfully updated. Flash CRC: ' + receivedCRC, successCallback);

            }

        }

    });

}

/* Send EOF message to device and wait for confirmation */

function confirmEOF (expectedCRC, isDestructive, successCallback) {

    const sendBuffer = Buffer.from([EOF]);
    const responseLength = 1;
    const regex = new RegExp(String.fromCharCode(ACK));

    send(sendBuffer, responseLength, regex, (err, response) => {

        if (err) {

            electronLog.error('Did not receive ACK from AudioMoth after sending end of file');
            displayError('Failed to flash device.', 'End of file acknowledgement was not received from AudioMoth. Switch to USB/OFF, detach and reattach your device, and try again.');
            stopCommunicating();

        } else {

            electronLog.log('Successfully sent all blocks and received EOF message');

            clearTimeout(responseTimeout);

            crcCheck(expectedCRC, isDestructive, successCallback);

        }

    });

}

/* Create the nth buffer to send to the device */

function generateSendBuffer (n) {

    let crcString = crc16(splitBuffers[n]).toString(16);

    /* If the CRC is an odd length, pad it with a zero */
    if (crcString.length % 2 === 1) {

        crcString = '0'.concat(crcString);

    }

    /* CRC must be 2 bytes of length, pad with zeroes to achieve this */
    if (crcString.length === 2) {

        crcString = '00'.concat(crcString);

    }

    const bn = n + 1;

    /** Buffer format:
     * Start of Header byte
     * Block number
     * Inverse block number (for error checking)
     * Data
     * CRC
     */
    const sendBuffer = Buffer.concat([Buffer.from([SOH]),
        Buffer.from([bn]),
        Buffer.from([(0xFF - bn)]),
        splitBuffers[n],
        Buffer.from(crcString, 'hex')
    ]);

    return sendBuffer;

}

/* Looping function which sends each data buffer, repeating blocks which time out */

function sendFirmwareData (expectedCRC, isDestructive, successCallback) {

    /* Calculate the current block to be sent */
    blockNumber = lower + numberOfRepeats % (upper - lower + 1);

    electron.ipcRenderer.send('set-bar-serial-flash-progress', blockNumber);

    /* If all blocks have been sent, send EOF */
    if (blockNumber >= splitBuffers.length) {

        confirmEOF(expectedCRC, isDestructive, successCallback);
        return;

    }

    /* If a single block has timed out too many times, cancel flash */
    if (numberOfRepeats >= MAX_REPEATS) {

        electronLog.error('Attempted and failed to send firmware data', numberOfRepeats, 'times. Giving up.');
        displayError('Failed to flash device.', 'AudioMoth is no longer responding. Switch to USB/OFF, detach and reattach your device, and try again.');
        clearTimeout(responseTimeout);
        timedOut = false;
        flashFailed = true;
        stopCommunicating();

        return;

    }

    const sendBuffer = generateSendBuffer(blockNumber);

    /* Set expected response information */
    const responseLength = 1;
    const regex = new RegExp(String.fromCharCode(ACK));

    numberOfRepeats++;

    timedOut = false;

    send(sendBuffer, responseLength, regex, (err, response) => {

        if (flashFailed) {

            return;

        }

        if (timedOut) {

            /* Update current block number calculation */
            upper = Math.min(Math.max(upper, blockNumber + 1), splitBuffers.length - 1);
            electronLog.log('Block ', blockNumber, ' timed out, reattempting');

        } else {

            electronLog.log('Completed block ' + (blockNumber + 1) + ' of ' + splitBuffers.length);

            if (err) {

                electronLog.log('Resending packet');

                if (port.isOpen) {

                    port.flush();

                }

            } else {

                /* Send was successful, move ot next block */
                numberOfRepeats = 0;
                lower = blockNumber + 1;
                upper = lower;

            }

        }

        sendFirmwareData(expectedCRC, isDestructive, successCallback);

    });

}

function readyCheck (sendBuffer, expectedCRC, isDestructive, successCallback, infoText, maxBlocks) {

    electron.ipcRenderer.send('set-bar-serial-ready-check', readyCheckCount);

    if (readyCheckCount >= MAX_READY_CHECK_COUNT) {

        clearTimeout(readyTimeout);

        electronLog.error('Didn\'t receive expected ready response after ' + MAX_READY_CHECK_COUNT + ' attempts');
        displayError('Failed to flash device.', 'Ready signal was not received from AudioMoth. Switch to USB/OFF, detach and reattach your device, and try again.');

        stopCommunicating();

        return;

    }

    readyCheckCount++;

    const responseLength = 11;
    const regex = /Ready/;

    /* Send initial write message, signalling start of XMODEM process */
    send(sendBuffer, responseLength, regex, (err, response) => {

        if (err) {

            electronLog.log('Didn\'t receive expected response, trying ready message again');

            readyTimeout = setTimeout(function () {

                readyCheck(sendBuffer, expectedCRC, isDestructive, successCallback, infoText, maxBlocks);

            }, READY_CHECK_DELAY_LENGTH * Math.pow(2, readyCheckCount));

        } else {

            electronLog.log('Ready response received after ' + readyCheckCount + ' attempts');

            numberOfRepeats = 0;
            blockNumber = 0;

            /* Send information to main process to start progress bar */
            electron.ipcRenderer.send('set-bar-flashing');
            electron.ipcRenderer.send('set-bar-info', infoText, maxBlocks);

            electronLog.log('AudioMoth is ready, sending firmware chunks');
            sendFirmwareData(expectedCRC, isDestructive, successCallback);

        }

    });

}

/* Start serial flash process */

function sendFirmware (buffer, isDestructive, expectedCRC, successCallback, infoText, maxBlocks) {

    flashFailed = false;

    splitBuffers = [];
    let currentBlock = Buffer.alloc(BLOCK_SIZE);

    numberOfRepeats = 0;
    lower = 0;
    upper = 0;
    blockNumber = 0;

    /* Split firmware into blocks of size BLOCK_SIZE */
    while (buffer.length > 0) {

        for (let i = 0; i < BLOCK_SIZE; i++) {

            currentBlock[i] = buffer[i] === undefined ? FILLER : buffer[i];

        }

        buffer = buffer.slice(BLOCK_SIZE);
        splitBuffers.push(currentBlock);
        currentBlock = Buffer.alloc(BLOCK_SIZE);

    }

    /* Destructive and non-destructive writes require different initial messages */
    const writeType = isDestructive ? 'd' : 'u';
    const sendBuffer = Buffer.from(writeType);

    readyCheckCount = 0;

    readyCheck(sendBuffer, expectedCRC, isDestructive, successCallback, infoText, maxBlocks);

}

exports.sendFirmware = sendFirmware;
