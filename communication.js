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
const PORT_TIMEOUT_LENGTH = 5000;

/* Counter for ready checks */
const MAX_READY_CHECK_COUNT = 50;
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

/* Reusable connection error  */
var noAudioMothError = new Error('No AudioMoth found!\nCheck connection and try again.');

/* Device statuses */
exports.STATUS_USB_DRIVE_BOOTLOADER = 0;
exports.STATUS_SERIAL_BOOTLOADER = 1;
exports.STATUS_NO_AUDIOMOTH = 2;
exports.STATUS_AUDIOMOTH_AUTO = 3;
exports.STATUS_AUDIOMOTH_MANUAL = 4;

/* Generate Cyclical Redundancy Check code */

function crc16 (buffer) {

    var crc, byte, code;

    crc = 0x0;

    for (let i = 0; i < buffer.length; i++) {

        byte = buffer[i];
        code = (crc >>> 8) & 0xFF;

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

    var drives, drive;

    try {

        drives = await drivelist.list();

        /* Iterate through all connected drives, matching description and drive capacity with known AudioMoth MSD values */
        for (let i = 0; i < drives.length; i++) {

            drive = drives[i];

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

    var msdPath = await getMsdPath();

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

    var uploadPath, stats;

    /* Reset progress bar progress */
    msdProgress = 0;

    /* Check binary size will fit on device */
    stats = fs.statSync(path);

    if (stats.size > MAX_FILE_SIZE_MSD) {

        failureCallback(new Error('Selected binary is too large for USB drive flashing.'));
        return;

    }

    /* Get the path of the MSD drive */
    uploadPath = await getMsdPath();

    if (uploadPath === null) {

        failureCallback(new Error('Unable to find AudioMoth USB drive.'));
        return;

    }

    uploadPath = uploadPath + '/FIRMWARE.BIN';

    /* Copy firmware binary into MSD, starting flash process */
    fs.copyFile(path, uploadPath, function (err) {

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
                    failureCallback(new Error('Device failed to restart after flashing using USB drive bootloader.\nSwitch to USB/OFF, detach, reattach your device, and try again.'));

                }, MSD_RESET_TIMEOUT_LENGTH);

            });

        }

    });

}

exports.uploadFirmwareToMsd = uploadFirmwareToMsd;

/* Check all serial ports and return port name if AudioMoth is found */

async function getAudioMothPortName () {

    var ports, p, vid, pid, path;

    ports = await SerialPort.list();

    for (let i = 0; i < ports.length; i += 1) {

        p = ports[i];

        vid = p.vendorId;
        pid = p.productId;
        path = p.path;

        if (vid !== undefined && pid !== undefined && path !== undefined) {

            vid = vid.toUpperCase();

            /* Vendor ID varies based on when the AudioMoth was manufactured */
            if ((vid === '10C4' || vid === '2544') && pid === '0003') {

                return path;

            }

        }

    }

    electronLog.log('Failed to find AudioMoth port. Ports found:');

    for (let i = 0; i < ports.length; i += 1) {

        p = ports[i];
        electronLog.log(p.vendorId + ', ' + p.productId + ', ' + p.path);

    }

    throw noAudioMothError;

}

exports.getAudioMothPortName = getAudioMothPortName;

/* Verify the device is now in the bootloader */

async function checkBootloaderSwitch (callback) {

    var deviceFound, msdPath, msdFound;

    /* Check for serial bootloader */
    deviceFound = await isInBootloader();

    if (deviceFound) {

        clearTimeout(bootloaderCheckTimeout);
        callback();

    } else {

        /* Check for MSD bootloader */
        msdPath = await getMsdPath();
        msdFound = msdPath !== null;

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

            callback(new Error('Failed to switch AudioMoth to flash mode.\nSwitch to USB/OFF, detach, reattach your device, and try again.'));
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
                callback(new Error('Failed to switch AudioMoth to flash mode.\nSwitch to USB/OFF, detach, reattach your device, and try again.'));

            }, BOOTLOADER_CHECK_MAX_TIMEOUT_LENGTH);

        } else {

            callback(new Error('Attached device\'s firmware does not support bootloader switching over HID.'));

        }

    });

}

exports.requestBootloader = requestBootloader;

/* Function called whenever 1 byte of data is received */

function receive (data) {

    var regexResult;

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
        regexResult = responseRegex.exec(queue.toString('utf8'));

        /* Only return response if it matches the expected regex */
        if (regexResult) {

            switch (responseRegex.source) {

            case String.fromCharCode(ACK):
                electronLog.log('Received expected response: "ACK"');
                break;

            case String.fromCharCode(EOF):
                electronLog.log('Received expected response: "EOF"');
                break;

            default:
                electronLog.log('Received expected response: "' + regexResult[0] + '"');
                break;

            }

            completionFunction(regexResult[0]);

        } else {

            electronLog.error('Unexpected response: "' + queue + '"');
            completionFunction(false);

        }

    }

}

/* Send buffer to AudioMoth on given port */

async function send (buffer, expectedLength, regex, callback) {

    receiveComplete = false;

    /* Set response expectations */
    responseExpectedLength = expectedLength;

    /* Set REGEX */
    responseRegex = regex;

    /* Set function which will be run after the right number of bytes have been received and the response matches responseRegex */
    completionFunction = callback;

    /* Clear buffer */
    queue = Buffer.alloc(0);

    electronLog.log('Sending buffer');

    /* Send command */
    port.write(buffer, function (err) {

        electronLog.log('Written to port');

        if (err) {

            electronLog.error(err);
            port.close();

        }

    });

    electronLog.log('Setting timeout');

    responseTimeout = setTimeout(function () {

        electronLog.error('Timed out waiting for response');

        timedOut = true;

        completionFunction(false);

    }, PORT_TIMEOUT_LENGTH);

    timedOut = false;

}

/* Open a port with given name, calling each of the given callbacks when the port opens/closes */

function openPort (name, openCallback, closeCallback, errorCallback) {

    var parser;

    /* Clear buffer */
    queue = Buffer.alloc(0);

    /* Open a connection to the port at the given path */
    port = new SerialPort(name, {
        baudRate: 9600
    }, false);

    port.on('open', function () {

        openCallback();

    });

    /* Add functions to event listeners if they're provided */
    if (closeCallback) {

        port.on('close', closeCallback);

    }

    if (errorCallback) {

        portErrorCallback = errorCallback;

    }

    port.on('error', function (err) {

        electronLog.error(err);
        displayError('Failed to open port.', 'Could not connect to AudioMoth.\nReconnect device and flash again.');

        if (portErrorCallback) {

            portErrorCallback();

        }

    });

    /* Every time 1 byte is received, call receive(data) */
    parser = port.pipe(new ByteLength({length: 1}));
    parser.on('data', receive);

}

exports.openPort = openPort;

/* Query AudioMoth as to whether it supports switching from USB mode to the bootloader in response to a packet */

function queryBootloaderSwitching (callback) {

    audiomoth.queryBootloader(function (err, supportsBootloaderSwitch) {

        if (err || supportsBootloaderSwitch === null) {

            callback(new Error('Could not connect to device to query whether it supports flash mode switching.\nVerify connection and try again.'));

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

            callback(new Error('Could not connect to device to obtain firmware version.\nVerify connection and try again.'));

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

            callback(new Error('Could not connect to device to obtain firmware description.\nVerify connection and try again.'));

        } else {

            callback(null, description);

        }

    });

}

exports.requestFirmwareDescription = requestFirmwareDescription;

/* Attempt to retrieve the port name of a connected ID, if one is found return true, else return false */

async function isInBootloader () {

    try {

        /* Asynchronously obtain the port of the AudioMoth */
        await getAudioMothPortName();

        return true;

    } catch (err) {

        return false;

    }

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

function stopCommunicating () {

    communicating = false;

}
exports.stopCommunicating = stopCommunicating;

/* Request the CRC of the firmware currently on the AudioMoth */

function requestCRC (isDestructive, callback) {

    var readType, sendBuffer, responseLength, regex;

    /* If the flash is destructive, then the CRC should take into account the bootloader as well as the firmware itself */
    readType = isDestructive ? 'v' : 'c';

    sendBuffer = Buffer.from(readType);
    responseLength = 18;
    regex = /CRC: 0000[A-Z0-9]{4}/;

    send(sendBuffer, responseLength, regex, callback);

}

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

    electronLog.log('Reset failed, closing port');

    port.close();

    dialog.showMessageBox({
        type: 'warning',
        icon: path.join(__dirname, '/icon-64.png'),
        title: 'Flashing complete',
        buttons: ['OK'],
        message: message + '\nSwitch to USB/OFF, detach, and then reattach your device to verify new firmware version.'
    });

    stopCommunicating();

}

/* Send reset message to device then wait for the bootloader to disappear from serial port list */

function checkSerialComplete (message, successCallback) {

    var sendBuffer, responseLength, regex;

    /* Send full reset message */
    sendBuffer = Buffer.from('r');
    responseLength = 1;
    regex = /r/;

    send(sendBuffer, responseLength, regex, function (response) {

        clearTimeout(flashResetTimeout);
        clearTimeout(responseTimeout);

        if (port.isOpen) {

            port.close();

        }

        electronLog.log('Reset message sent, response: "' + response + '"');

        if (!response) {

            resetFailure(message);
            return;

        }

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

    var receivedCRC, errorString;

    requestCRC(isDestructive, function (response) {

        if (response) {

            /* CRC message sent by bootloader is prepended with 'CRC:', so only the last 4 characters which actually contain the CRC are needed */
            receivedCRC = response.substr(response.length - 4, 4);

            if (expectedCRC) {

                electronLog.log('Comparing CRCs');
                electronLog.log('Expected: ' + expectedCRC);
                electronLog.log('Received: ' + receivedCRC);

                if (receivedCRC === expectedCRC) {

                    electronLog.log('Resetting device');
                    checkSerialComplete('Firmware has been successfully updated.', successCallback);

                } else {

                    errorString = 'Flash CRC did not match.\n';
                    errorString += 'Expected ' + expectedCRC + ' but received ' + receivedCRC + '\n';
                    errorString += '\nReconnect device and flash again.';
                    displayError('Incorrect CRC', errorString);
                    electron.ipcRenderer.send('set-bar-aborted');
                    stopCommunicating();
                    port.close();

                }

            } else {

                checkSerialComplete('Firmware has been successfully updated. Flash CRC: ' + receivedCRC, successCallback);

            }

        } else {

            displayError('Unable to verify success', 'Flash completed, but success could not be verified.\nSwitch to USB/OFF, detach, reattach your device, and flash again.');
            electron.ipcRenderer.send('set-bar-aborted');
            stopCommunicating();

            port.close();

        }

    });

}

/* Send EOF message to device and wait for confirmation */

function confirmEOF (expectedCRC, isDestructive, successCallback) {

    var sendBuffer, responseLength, regex;

    sendBuffer = Buffer.from([EOF]);
    responseLength = 1;
    regex = new RegExp(String.fromCharCode(ACK));

    send(sendBuffer, responseLength, regex, function (response) {

        if (response) {

            electronLog.log('Successfully sent all blocks and received EOF message');

            clearTimeout(responseTimeout);

            crcCheck(expectedCRC, isDestructive, successCallback);

        } else {

            electronLog.error('Did not receive ACK from AudioMoth after sending end of file');
            displayError('Failed to flash device.', 'End of file acknowledgement was not received from AudioMoth.\nSwitch to USB/OFF, detach, reattach your device, and try again.');
            stopCommunicating();

        }

    });

}

/* Create the nth buffer to send to the device */

function generateSendBuffer (n) {

    var bn, crcString, sendBuffer;

    crcString = crc16(splitBuffers[n]).toString(16);

    /* If the CRC is an odd length, pad it with a zero */
    if (crcString.length % 2 === 1) {

        crcString = '0'.concat(crcString);

    }

    /* CRC must be 2 bytes of length, pad with zeroes to achieve this */
    if (crcString.length === 2) {

        crcString = '00'.concat(crcString);

    }

    bn = n + 1;

    /** Buffer format:
     * Start of Header byte
     * Block number
     * Inverse block number (for error checking)
     * Data
     * CRC
     */
    sendBuffer = Buffer.concat([Buffer.from([SOH]),
        Buffer.from([bn]),
        Buffer.from([(0xFF - bn)]),
        splitBuffers[n],
        Buffer.from(crcString, 'hex')
    ]);

    return sendBuffer;

}

/* Looping function which sends each data buffer, repeating blocks which time out */

function sendFirmwareData (expectedCRC, isDestructive, successCallback) {

    var sendBuffer, responseLength, regex;

    /* Calculate the current block to be sent */
    blockNumber = lower + numberOfRepeats % (upper - lower + 1);

    electron.ipcRenderer.send('set-bar-serial-flash-progress', blockNumber);

    /* If all blocks have been sent, send EOF */
    if (blockNumber >= splitBuffers.length) {

        confirmEOF(expectedCRC, isDestructive, successCallback);
        return;

    }

    /* If a single block has timed out too many times, cancel flash */
    if (numberOfRepeats > MAX_REPEATS) {

        electronLog.error('TOO MANY REPEATS');
        displayError('Failed to flash device.', 'AudioMoth is no longer responding.\nSwitch to USB/OFF, detach, reattach your device, and try again.');
        clearTimeout(responseTimeout);
        timedOut = false;
        stopCommunicating();

        return;

    }

    sendBuffer = generateSendBuffer(blockNumber);

    /* Set expected response information */
    responseLength = 1;
    regex = new RegExp(String.fromCharCode(ACK));

    numberOfRepeats++;

    send(sendBuffer, responseLength, regex, function (response) {

        if (timedOut) {

            /* Update current block number calculation */
            upper = Math.min(Math.max(upper, blockNumber + 1), splitBuffers.length - 1);
            electronLog.log('Block ', blockNumber, ' timed out, reattempting');

        } else {

            // electronLog.log(sendBuffer);
            electronLog.log(blockNumber + ' / ' + splitBuffers.length);

            if (response) {

                /* Send was successful, move ot next block */
                numberOfRepeats = 0;
                lower = blockNumber + 1;
                upper = lower;

            } else {

                electronLog.log('NAK received, resending');

            }

        }

        sendFirmwareData(expectedCRC, isDestructive, successCallback);

    });

}

function readyCheck (sendBuffer, expectedCRC, isDestructive, successCallback) {

    var responseLength, regex;

    if (readyCheckCount >= MAX_READY_CHECK_COUNT) {

        electronLog.error('Didn\'t receive expected ready response after ' + MAX_READY_CHECK_COUNT + ' attempts');
        displayError('Failed to flash device.', 'Ready signal was not received from AudioMoth.\nSwitch to USB/OFF, detach, reattach your device, and try again.');
        stopCommunicating();

    }

    readyCheckCount++;

    responseLength = 11;
    regex = /Ready/;

    /* Send initial write message, signalling start of XMODEM process */
    send(sendBuffer, responseLength, regex, function (response) {

        if (response) {

            electronLog.log('Ready response received after ' + readyCheckCount + ' attempts');

            numberOfRepeats = 0;
            blockNumber = 0;

            electronLog.log('AudioMoth is ready, sending firmware chunks');
            sendFirmwareData(expectedCRC, isDestructive, successCallback);

        } else {

            electronLog.log('Didn\'t receive expected response, trying ready message again');

            setTimeout(function () {

                readyCheck(sendBuffer, expectedCRC, isDestructive, successCallback);

            }, READY_CHECK_DELAY_LENGTH);

        }

    });

}

/* Start serial flash process */

function sendFirmware (buffer, isDestructive, expectedCRC, successCallback) {

    var currentBlock, writeType, sendBuffer;

    splitBuffers = [];
    currentBlock = Buffer.alloc(BLOCK_SIZE);

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
    writeType = isDestructive ? 'd' : 'u';
    sendBuffer = Buffer.from(writeType);

    readyCheckCount = 0;

    readyCheck(sendBuffer, expectedCRC, isDestructive, successCallback);

}

exports.sendFirmware = sendFirmware;
