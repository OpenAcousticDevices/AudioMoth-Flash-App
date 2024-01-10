/****************************************************************************
 * communication.js
 * openacousticdevices.info
 * October 2019
 *****************************************************************************/

'use strict';

const electron = require('electron');
const {dialog} = require('@electron/remote');

const audiomoth = require('audiomoth-hid');

const {SerialPort, ByteLengthParser} = require('serialport');
const fs = require('fs');
const path = require('path');
const util = require('util');
const electronLog = require('electron-log');

/* Flash constants */

const MAXIMUM_RETRIES = 10;
const DEFAULT_RETRY_INTERVAL = 100;
const DEFAULT_DELAY_BETWEEN_PACKETS = 10;
const DEFAULT_DELAY_BETWEEN_CRC_REQUESTS = 500;
const MAXIMUM_FIRMWARE_PACKET_SIZE = 56;
const NUMBER_OF_BUFFER_TO_SEND = process.platform === 'win32' ? 30 : 60;

/* USB HID flashing constants */

/* eslint-disable no-multi-spaces,no-unused-vars */
const AM_BOOTLOADER_GET_VERSION                 = 0x01;
const AM_BOOTLOADER_INITIALISE_SRAM             = 0x02;
const AM_BOOTLOADER_CLEAR_USER_DATA             = 0x03;
const AM_BOOTLOADER_SET_SRAM_FIRMWARE_PACKET    = 0x04;
const AM_BOOTLOADER_CALC_SRAM_FIRMWARE_CRC      = 0x05;
const AM_BOOTLOADER_CALC_FLASH_FIRMWARE_CRC     = 0x06;
const AM_BOOTLOADER_GET_FIRMWARE_CRC            = 0x07;
const AM_BOOTLOADER_FLASH_FIRMWARE              = 0x08;
/* eslint-enable no-multi-spaces,no-unused-vars */

/* Timeout to close port if message is sent and no response is received */
const PORT_TIMEOUT_LENGTH = 1500;

/* Counter for ready checks */
const MAX_READY_CHECK_COUNT = 7;
let readyCheckCount;
const READY_CHECK_DELAY_LENGTH = 100;

/* Timeout to wait for a switch to bootloader mode after the message is sent */
const BOOTLOADER_CHECK_MAX_TIMEOUT_LENGTH = 10000;
const BOOTLOADER_CHECK_TIMEOUT_LENGTH = 100;
let bootloaderCheckTimeout;
let bootloaderCheckTimedOut = false;

/* Timeout to wait for a reset after flash */
const RESET_TIMEOUT_LENGTH = 7500;
const RESET_CHECK_TIMEOUT_LENGTH = 100;

/* Time spent resetting */
let resetTime;

/* Whether or not the app is in the process of communicating with a device (used to prevent spamming requests) */
let communicating = false;

/* Serial port through which AudioMoth communication is taking place */
let port;
/* Buffer object which extends as more bytes are received */
let queue;
/* Regex to be applied to the queue buffer when it's full */
let responseRegex;
/* Number of bytes expected as a response to a given message */
let responseExpectedLength;
/* Function which is run when correct response is received */
let completionFunction;

/* Callback called by openPort if failure occurs */
let portErrorCallback;

/* ID of timeout waiting for correct response */
let responseTimeout;
/* Whether or not a message request has already timed out */
let timedOut;

/* Number of times checking the user data checksum has been attempted */
let userDataCheckCount;
const MAX_USER_DATA_CHECK_COUNT = 5;
const USER_DATA_CHECK_DELAY_LENGTH = 100;

/* Timeout for attempting another ready check */
let readyTimeout;

let receiveComplete;

/* ID of timeout waiting for reset response */
let flashResetTimeout;

/* xmodem values: */
const SOH = 0x01;
const EOF = 0x04;
const ACK = 0x06;
const FILLER = 0xFF;

const BLOCK_SIZE = 128;
exports.BLOCK_SIZE = BLOCK_SIZE;
const MAX_REPEATS = 10;

/* Variables used to keep track of flash process */
let numberOfRepeats;
let blockNumber;
let lower = 0;
let upper = 0;

/* Array of buffers of length BLOCK_SIZE */
let splitBuffers;

/* Blank buffer for clearing the user data */

const blankBuffer = Buffer.alloc(128);

/* Device statuses */
exports.STATUS_SERIAL_BOOTLOADER = 1;
exports.STATUS_NO_AUDIOMOTH = 2;
exports.STATUS_AUDIOMOTH_AUTO = 3;
exports.STATUS_AUDIOMOTH_MANUAL = 4;
exports.STATUS_AUDIOMOTH_USB = 5;

/* Flag indicating the overall process has failed and shouldn't continue */
let flashFailed = false;

/**
 * Call a synchronous function, repeating a fixed number of times with a delay between each attempt
 * @param {function} funcSync Synchronous function being called
 * @param {*} argument Argument(s) sent to function
 * @param {int} milliseconds Delay between attempts
 * @param {int} repeats Number of attempts before giving up
 * @returns Result of function
 */
async function callWithRetry (funcSync, argument, milliseconds, repeats) {

    let result;

    let attempt = 0;

    while (attempt < repeats) {

        try {

            if (argument) {

                result = await funcSync(argument);

            } else {

                result = await funcSync();

            }

            break;

        } catch (e) {

            const interval = milliseconds / 2 + milliseconds / 2 * Math.random();

            await delay(interval);

            attempt += 1;

        }

    }

    if (result === undefined) {

        throw ('Error: Repeated attempts to access the AudioMoth failed.');

    }

    if (result === null) {

        throw ('Error: No AudioMoth detected.');

    }

    return result;

}

/**
 * Wait a given number of milliseconds
 * @param {int} milliseconds Pause length
 */
async function delay (milliseconds) {

    return new Promise(resolve => setTimeout(resolve, milliseconds));

}

/* Promisified versions of AudioMoth-HID calls */

const queryUSBHIDBootloader = util.promisify(audiomoth.queryUSBHIDBootloader);
const sendPacketToUSBHIDBootloader = util.promisify(audiomoth.sendPacketToUSBHIDBootloader);
const sendMultiplePacketsToUSBHIDBootloader = util.promisify(audiomoth.sendMultiplePacketsToUSBHIDBootloader);
const switchToBootloader = util.promisify(audiomoth.switchToBootloader);
const queryBootloader = util.promisify(audiomoth.queryBootloader);
const getFirmwareVersion = util.promisify(audiomoth.getFirmwareVersion);
const getFirmwareDescription = util.promisify(audiomoth.getFirmwareDescription);

async function getStatus () {

    try {

        const supportsUSBHIDFlash = await callWithRetry(queryUSBHIDBootloader, null, DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);
        const supportsBootloaderSwitch = await callWithRetry(queryBootloader, null, DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);
        const firmwareVersion = await callWithRetry(getFirmwareVersion, null, DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);
        const firmwareDescription = await callWithRetry(getFirmwareDescription, null, DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

        return {
            supportsUSBHIDFlash,
            supportsBootloaderSwitch,
            firmwareVersion,
            firmwareDescription
        };

    } catch (err) {

        return null;

    }

}

exports.getStatus = getStatus;

/**
 * Close serial port if it's open
 */
function closePort () {

    if (port !== undefined) {

        if (port.isOpen) {

            port.close();

        }

    }

}

exports.closePort = closePort;

/**
 * @param {buffer} buffer Buffer of data being checked
 * @returns Cyclical Redundancy Check code (CRC)
 */
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

/**
 * Create error message window which blocks interaction with the main window
 * @param {string} title Text in title bar
 * @param {string} message Text in error message body
 */
function displayError (title, message) {

    electron.ipcRenderer.send('set-bar-aborted');

    dialog.showMessageBox({
        type: 'error',
        icon: path.join(__dirname, '/icon-64.png'),
        title,
        buttons: ['OK'],
        message
    });

}

exports.displayError = displayError;

/**
 * Check all serial ports and return port name if AudioMoth is found
 * @returns Name of the port where an AudioMoth can be found
 */
async function getAudioMothPortName () {

    const ports = await SerialPort.list();

    for (let i = 0; i < ports.length; i += 1) {

        const p = ports[i];

        let vid = p.vendorId;
        const pid = p.productId;
        const portPath = p.path;

        if (vid !== undefined && pid !== undefined && portPath !== undefined) {

            vid = vid.toUpperCase();

            /* Vendor ID varies based on when the AudioMoth was manufactured */
            if ((vid === '10C4' || vid === '2544') && pid === '0003') {

                return portPath;

            }

        }

    }

    return false;

}

exports.getAudioMothPortName = getAudioMothPortName;

/**
 * Verify the device is now in the bootloader
 * @param {function} callback Called when verification is complete
 */
async function checkBootloaderSwitch (callback) {

    /* Check for serial bootloader */
    const deviceFound = await isInBootloader();

    if (deviceFound) {

        clearTimeout(bootloaderCheckTimeout);
        callback();

    } else {

        if (!bootloaderCheckTimedOut) {

            setTimeout(() => {

                checkBootloaderSwitch(callback);

            }, BOOTLOADER_CHECK_TIMEOUT_LENGTH);

        }

    }

}

/**
 * Send message to AudioMoth in USB mode to switch to bootloader
 * @param {function} callback Called when request has a response. Called with an error argument if one occurred
 */
async function requestBootloader (callback) {

    /* Send bootloader request packet and await confirmation message */

    try {

        const switchedToBootloader = await callWithRetry(switchToBootloader, null, DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

        /* Check for expected confirmation response */

        if (switchedToBootloader) {

            electronLog.log('Attached AudioMoth switching to serial flash mode');

            /* Device will load bootloader, repeatedly check for the appearance of a serial bootloader until timeout */
            bootloaderCheckTimedOut = false;
            checkBootloaderSwitch(callback);

            bootloaderCheckTimeout = setTimeout(() => {

                bootloaderCheckTimedOut = true;

                callback('Error: Failed to switch AudioMoth to serial flash mode. Detach and reattach your AudioMoth, and try again.');

            }, BOOTLOADER_CHECK_MAX_TIMEOUT_LENGTH);

        } else {

            callback('Error: AudioMoth refused to switch to serial flash mode. Detach and reattach your AudioMoth, and try again.');

        }

    } catch (err) {

        callback('Error: Failed to switch AudioMoth to serial flash mode. Detach and reattach your AudioMoth, and try again.');

    }

}

exports.requestBootloader = requestBootloader;

/**
 * Function called whenever 1 byte of data is received
 * @param {buffer} data Buffer containing 1 byte of data
 */
function receive (data) {

    if (port === undefined) {

        return;

    }

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
            completionFunction('Error: Unexpected response: "' + queue.toString('hex') + '"');

        }

    }

}

/**
 * Send buffer to AudioMoth on given port
 * @param {buffer} buffer Data to be sent
 * @param {int} expectedLength Expected length of response
 * @param {regex} regex Regex to be applied to response
 * @param {function} callback Called when completed sending
 */
async function send (buffer, expectedLength, regex, callback) {

    if (flashFailed || port === undefined) {

        return;

    }

    if (!port.isOpen) {

        electronLog.error('Sending buffer failed. Port is closed');
        clearTimeout(responseTimeout);

        if (completionFunction) {

            completionFunction('Error: Sending buffer failed. Port is closed');

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

    responseTimeout = setTimeout(() => {

        electronLog.error('Timed out waiting for response');

        timedOut = true;

        completionFunction('Error: Timed out waiting for response');

    }, PORT_TIMEOUT_LENGTH);

    timedOut = false;

}

exports.setPortErrorCallback = (callback) => {

    portErrorCallback = callback;

};

exports.failFlash = () => {

    displayError('Communication failure', 'Could not connect to AudioMoth. Reconnect AudioMoth and try again.');

    flashFailed = true;

};

/**
 * Open a port with given name, calling each of the given callbacks when the port opens/closes
 * @param {string} name Name of port to be opened
 * @param {function} openCallback Called when port has been opened
 * @param {function} closeCallback Called when port closes
 * @param {function} errorCallback Called when an error occurs
 */
function openPort (name, openCallback, closeCallback, errorCallback) {

    /* Clear buffer */
    queue = Buffer.alloc(0);

    /* Open a connection to the port at the given path */
    port = new SerialPort({
        path: name,
        baudRate: 9600
    });

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
    const parser = port.pipe(new ByteLengthParser({length: 1}));
    parser.on('data', receive);

}

exports.openPort = openPort;

/**
 * Query AudioMoth as to whether it supports switching from USB mode to the bootloader in response to a packet
 * @param {function} callback Called when response is received
 */
async function queryBootloaderSwitching (callback) {

    try {

        const supportsBootloaderSwitch = await callWithRetry(queryBootloader, null, DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

        callback(null, supportsBootloaderSwitch);

    } catch (err) {

        callback('Error: Could not connect to AudioMoth to query whether it supports serial flash mode switching. Verify connection and try again.');

    }

}

exports.queryBootloaderSwitching = queryBootloaderSwitching;

/**
 * Request current firmware version. When response is received, run callback with string containing version number as the only argument
 * @param {function} callback Called when response is received
 */
async function requestFirmwareVersion (callback) {

    try {

        const versionArr = await callWithRetry(getFirmwareVersion, null, DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

        callback(null, versionArr[0] + '.' + versionArr[1] + '.' + versionArr[2]);

    } catch (err) {

        callback('Error: Could not connect to AudioMoth to obtain firmware version. Verify connection and try again.');

    }

}

exports.requestFirmwareVersion = requestFirmwareVersion;

/**
 * Request current firmware description. When response is received, run callback with string containing description assigned in firmware source
 * @param {function} callback Called when response is received
 */
async function requestFirmwareDescription (callback) {

    try {

        const description = await callWithRetry(getFirmwareDescription, null, DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

        callback(null, description);

    } catch (err) {

        callback('Error: Could not connect to AudioMoth to obtain firmware description. Verify connection and try again.');

    }

}

exports.requestFirmwareDescription = requestFirmwareDescription;

/**
 * Attempt to retrieve the port name of a connected ID, if one is found return true, else return false
 */
async function isInBootloader () {

    /* Asynchronously obtain the port of the AudioMoth */
    const audioMothPortName = await getAudioMothPortName();

    return audioMothPortName !== false;

}

exports.isInBootloader = isInBootloader;

/**
 * Return variable representing communication between the app and a device which prevents overlapping communication
 */
function isCommunicating () {

    return communicating;

}
exports.isCommunicating = isCommunicating;

function startCommunicating () {

    communicating = true;

}
exports.startCommunicating = startCommunicating;

/**
 * Set communication flag to false and then close the port if it's currently open
 */
function stopCommunicating () {

    communicating = false;

    closePort();

}
exports.stopCommunicating = stopCommunicating;

/**
 * Request the CRC of the firmware currently on the AudioMoth
 * @param {boolean} isDestructive If the flash is destructive, then the CRC should take into account the bootloader as well as the firmware itself
 * @param {function} callback Called when send action is complete
 */
function requestCRC (isDestructive, callback) {

    /* If the flash is destructive, then the CRC should take into account the bootloader as well as the firmware itself */
    const readType = isDestructive ? 'v' : 'c';

    const sendBuffer = Buffer.from(readType);
    const responseLength = 18;
    const regex = /CRC: 0000[A-Z0-9]{4}/;

    send(sendBuffer, responseLength, regex, callback);

}

/**
 * Request the version of the bootloader currently installed on the AudioMoth
 * @param {function} callback Called when response is received
 */
function requestBootloaderVersion (callback) {

    const sendBuffer = Buffer.from('i');
    const responseLength = 54;
    const regex = /BOOTLOADER version [0-9]\.[0-9]{2}, Chip ID [0-9A-Z]{16}/;

    send(sendBuffer, responseLength, regex, (err, response) => {

        if (err) {

            callback('Error: Unable to establish communication with bootloader.');

        } else {

            const bootloaderVersion = parseFloat(response.substr(19, 23));
            callback(null, bootloaderVersion);

        }

    });

}

exports.requestBootloaderVersion = requestBootloaderVersion;

/**
 * Animate progress as app waits for flashed device to reset
 * @param {string} message Message displayed on serial flash progress window
 * @param {function} successCallback Called when restart has been successfully completed
 */
async function restartTimer (message, successCallback) {

    if (resetTime < RESET_TIMEOUT_LENGTH) {

        electron.ipcRenderer.send('set-bar-restart-progress', resetTime);

        setTimeout(() => {

            resetTime += RESET_CHECK_TIMEOUT_LENGTH;
            restartTimer(message, successCallback);

        }, RESET_CHECK_TIMEOUT_LENGTH);

    } else {

        electron.ipcRenderer.send('set-bar-restarted');
        successCallback(message);

    }

}

/**
 * Display message window explaining that resetting failed
 * @param {string} message Text appended to window body text (usually an explanation for the reset failure)
 */
function resetFailure (message) {

    electronLog.error('Reset failed');

    dialog.showMessageBox({
        type: 'warning',
        icon: path.join(__dirname, '/icon-64.png'),
        title: 'Flashing complete',
        buttons: ['OK'],
        message: message + ' Switch to USB/OFF, detach and reattach your AudioMoth to verify new firmware version.'
    });

    electron.ipcRenderer.send('set-bar-aborted');

    stopCommunicating();

}

/**
 * Send reset message to device then wait for the bootloader to disappear from serial port list
 * @param {string} message Text in window body
 * @param {function} successCallback Called when restart is completed successfully
 */
function resetDevice (message, successCallback) {

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

        electronLog.log('Waiting for AudioMoth to restart');

        /* Check device has reset */
        electron.ipcRenderer.send('set-bar-restarting', RESET_TIMEOUT_LENGTH);

        resetTime = 0;
        restartTimer(message, successCallback);

    });

    /* If there's no response to the reset message */
    flashResetTimeout = setTimeout(() => {

        resetFailure(message);

    }, 5000);

}

/**
 * Verify flash was successful by comparing new firmware CRC with previously calculated CRC
 * @param {string} expectedCRC Previously calculated CRC
 * @param {boolean} isDestructive Is the flash a destructive flash
 * @param {function} successCallback Called when CRC is successful and they match
 */
function crcCheck (expectedCRC, isDestructive, successCallback) {

    requestCRC(isDestructive, (err, response) => {

        if (err) {

            displayError('Communication failure', 'Flash completed but success could not be verified. Detach and reattach your AudioMoth, and try again.');
            electron.ipcRenderer.send('set-bar-aborted');
            stopCommunicating();

        } else {

            /* CRC message sent by bootloader is prepended with 'CRC:', so only the last 4 characters which actually contain the CRC are needed */
            const receivedCRC = response.substr(response.length - 4, 4);

            if (expectedCRC) {

                electronLog.log('Comparing CRCs');
                electronLog.log('Expected: ' + expectedCRC + ', Received: ' + receivedCRC);

                if (receivedCRC === expectedCRC) {

                    electronLog.log('Flash CRC was correct, resetting AudioMoth');
                    resetDevice('Firmware has been successfully updated.', successCallback);

                } else {

                    electronLog.error('Flash CRC was incorrect, ending communication');

                    let errorString = 'Flash failed, CRC did not match. ';
                    errorString += 'Expected ' + expectedCRC + ' but received ' + receivedCRC + '. ';
                    errorString += 'Reconnect AudioMoth and try again.';
                    displayError('Verification failure', errorString);
                    electron.ipcRenderer.send('set-bar-aborted');
                    stopCommunicating();

                }

            } else {

                resetDevice('Firmware has been successfully updated.\nFlash CRC: ' + receivedCRC, successCallback);

            }

        }

    });

}

/**
 * Send EOF message to device and wait for confirmation
 * @param {string} expectedCRC Previously calculated CRC
 * @param {boolean} isDestructive Is the flash destructive
 * @param {function} successCallback Called when flash is successful
 */
function confirmEOF (expectedCRC, isDestructive, successCallback) {

    const sendBuffer = Buffer.from([EOF]);
    const responseLength = 1;
    const regex = new RegExp(String.fromCharCode(ACK));

    send(sendBuffer, responseLength, regex, (err, response) => {

        if (err) {

            electronLog.error('Did not receive ACK from AudioMoth after sending end of file');
            displayError('Communication failure', 'End of file acknowledgement was not received from AudioMoth. Detach and reattach your AudioMoth, and try again.');
            stopCommunicating();

        } else {

            electronLog.log('Successfully sent all blocks and received EOF message');

            clearTimeout(responseTimeout);

            crcCheck(expectedCRC, isDestructive, successCallback);

        }

    });

}

/**
 * Create the nth buffer to send to the device
 * @param {int} n Buffer index
 * @returns Generated send buffer
 */
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

/**
 * Looping function which sends each data buffer, repeating blocks which time out
 * @param {string} expectedCRC Previously generated CRC
 * @param {boolean} isDestructive Is the flash destructive
 * @param {function} successCallback Called when flash is successful
 */
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
        displayError('Communication failure', '‘Something went wrong whilst flashing. Detach and reattach your AudioMoth, and try again.');
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

/**
 * Check if device is ready
 * @param {buffer} sendBuffer Buffer which will be sent
 * @param {boolean} updateProgressWindow Whether or not to update a progress bar window
 * @param {function} successCallback Called when flash is successful
 */
function readyCheck (sendBuffer, updateProgressWindow, successCallback) {

    if (updateProgressWindow) {

        electron.ipcRenderer.send('set-bar-serial-ready-check', readyCheckCount);

    }

    if (readyCheckCount >= MAX_READY_CHECK_COUNT) {

        clearTimeout(readyTimeout);

        electronLog.error('Didn\'t receive expected ready response after ' + MAX_READY_CHECK_COUNT + ' attempts');
        displayError('Communication failure', 'Ready signal was not received from AudioMoth. Detach and reattach your AudioMoth, and try again.');

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

            readyTimeout = setTimeout(() => {

                readyCheck(sendBuffer, updateProgressWindow, successCallback);

            }, READY_CHECK_DELAY_LENGTH * Math.pow(2, readyCheckCount));

        } else {

            electronLog.log('Ready response received after ' + readyCheckCount + ' attempts');

            numberOfRepeats = 0;
            blockNumber = 0;

            successCallback();

        }

    });

}

/**
 * Start serial flash process
 * @param {buffer} buffer Buffer containing firmware block
 * @param {boolean} isDestructive Is the flash destructive
 * @param {string} expectedCRC Previously generated CRC
 * @param {function} successCallback Called when flash is successful
 * @param {string} infoText Text displayed in progress bar window
 * @param {int} maxBlocks Total block count
 */
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

    readyCheck(sendBuffer, true, () => {

        /* Send information to main process to start progress bar */
        electron.ipcRenderer.send('set-bar-flashing');
        electron.ipcRenderer.send('set-bar-info', infoText, maxBlocks);

        electronLog.log('AudioMoth is ready, sending firmware chunks');

        sendFirmwareData(expectedCRC, isDestructive, successCallback);

    });

}

exports.sendFirmware = sendFirmware;

/**
 * Generate one of the buffers sent to the device to clear the user data buffer
 * @param {int} n Buffer index
 * @returns Buffer sent to device to clear buffer
 */
function generateClearDataBuffer (n) {

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
        blankBuffer,
        Buffer.from('0000', 'hex')
    ]);

    return sendBuffer;

}

/**
 * Send one of the buffers sent to the device to clear the user data buffer
 * @param {int} n Buffer index
 * @param {function} failureCallback Called if clear action fails
 * @param {function} successCallback Called when clear action is successful
 */
function sendUserDataClear (n, failureCallback, successCallback) {

    const sendBuffer = generateClearDataBuffer(n);
    const responseLength = 1;
    const regex = new RegExp(String.fromCharCode(ACK));

    send(sendBuffer, responseLength, regex, (err, response) => {

        if (err) {

            electronLog.error('Failed to clear user data -', err);

            failureCallback();

        } else {

            n++;

            if (n >= 16) {

                const sendBuffer = Buffer.from([EOF]);
                const responseLength = 1;
                const regex = new RegExp(String.fromCharCode(ACK));

                send(sendBuffer, responseLength, regex, (err, response) => {

                    if (err) {

                        electronLog.error('Did not receive ACK from AudioMoth after sending user data end of file');

                        displayError('Communication failure', 'User data EOF acknowledgement was not received from AudioMoth. Detach and reattach your AudioMoth, and try again.');

                        stopCommunicating();

                    } else {

                        electronLog.log('Successfully cleared user data and received EOF message');

                        clearTimeout(responseTimeout);

                        successCallback();

                    }

                });

            } else {

                sendUserDataClear(n, failureCallback, successCallback);

            }

        }

    });

}

/**
 * Use a checksum to verify clearing user data was successful
 * @param {function} successCallback Called if user data clear was completed successfully
 */
function checkUserDataClear (successCallback) {

    if (userDataCheckCount > MAX_USER_DATA_CHECK_COUNT) {

        electronLog.error('Didn\'t receive expected checksum response after ' + MAX_USER_DATA_CHECK_COUNT + ' attempts');

        displayError('Communication failure', 'User data checksum was not received from AudioMoth. Detach and reattach your AudioMoth, and try again.');

        stopCommunicating();

        return;

    }

    userDataCheckCount++;

    const sendBuffer = Buffer.from('n');

    const responseLength = 18;
    const regex = /CRC: 00000000/;

    /* Send initial write message, signalling start of XMODEM process */
    send(sendBuffer, responseLength, regex, (err, response) => {

        if (err) {

            electronLog.log('Didn\'t receive expected response, trying ready message again');

            readyTimeout = setTimeout(() => {

                checkUserDataClear(successCallback);

            }, USER_DATA_CHECK_DELAY_LENGTH * Math.pow(2, userDataCheckCount));

        } else {

            successCallback();

        }

    });

}

/**
 * Send command to clear user data containing configuration and wait for ready response
 * @param {function} failureCallback Called if clear action fails
 * @param {function} successCallback Called when clear action is successful
 */
function startUserDataClear (failureCallback, successCallback) {

    const sendBuffer = Buffer.from('t');

    readyCheckCount = 0;

    readyCheck(sendBuffer, false, () => {

        electronLog.log('AudioMoth is ready, sending blank user data');

        sendUserDataClear(0, failureCallback, () => {

            userDataCheckCount = 0;

            checkUserDataClear(successCallback);

        });

    });

}

exports.startUserDataClear = startUserDataClear;

/**
 * Flash using USB HID flashing
 * @param {string} firmwarePath Path to firmware file
 * @param {boolean} clearUserData Whether or not to clear the user data as part of the flash
 * @param {string} expectedCRC Precalculated CRC. undefined if one is not known before flashing (such as when using a local file)
 * @param {string} infoText Text to display in the body of the information window
 * @param {function} successCallback Called when flash has been completed successfully
 * @param {function} failureCallback Called when flash fails
 */
async function USBHIDFlash (firmwarePath, clearUserData, expectedCRC, infoText, successCallback, failureCallback) {

    electronLog.log('Flashing using USB HID flashing...');

    try {

        const firmwareData = fs.readFileSync(firmwarePath);

        let result;

        /* Initialise external SRAM */

        result = await callWithRetry(sendPacketToUSBHIDBootloader, [AM_BOOTLOADER_INITIALISE_SRAM], DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

        if (result[1] !== AM_BOOTLOADER_INITIALISE_SRAM) {

            throw ('Did not get correct response from AudioMoth.');

        }

        if (result[2] !== 0x01) {

            throw ('AudioMoth did not initialise SRAM.');

        }

        /* Send firmware packets */

        electron.ipcRenderer.send('set-bar-flashing');
        electron.ipcRenderer.send('set-bar-info', infoText, firmwareData.length);

        let i = 0;

        electronLog.log('Sending data');

        while (i < firmwareData.length) {

            let numberOfBuffers = 0;

            let totalNumberOfBytes = 0;

            const buffers = [];

            while (numberOfBuffers < NUMBER_OF_BUFFER_TO_SEND) {

                const offset = i + totalNumberOfBytes;

                const numberOfBytes = Math.min(MAXIMUM_FIRMWARE_PACKET_SIZE, firmwareData.length - offset);

                if (numberOfBytes === 0) {

                    break;

                }

                const buffer = [AM_BOOTLOADER_SET_SRAM_FIRMWARE_PACKET, offset & 0xFF, (offset >> 8) & 0xFF, (offset >> 16) & 0xFF, (offset >> 24) & 0xFF, numberOfBytes];

                for (let j = 0; j < numberOfBytes; j += 1) {

                    buffer.push(firmwareData[offset + j]);

                }

                totalNumberOfBytes += numberOfBytes;

                numberOfBuffers += 1;

                buffers.push(buffer);

            }

            result = await callWithRetry(sendMultiplePacketsToUSBHIDBootloader, buffers, DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

            if (result[1] !== AM_BOOTLOADER_SET_SRAM_FIRMWARE_PACKET) {

                throw ('Did not get correct response from AudioMoth.');

            }

            i += totalNumberOfBytes;

            electron.ipcRenderer.send('set-bar-serial-flash-progress', i);

            await delay(DEFAULT_DELAY_BETWEEN_PACKETS);

        }

        /* Check firmware CRC if one was provided to compare */

        if (expectedCRC === undefined) {

            /* Calculate CRC from uploaded file */

            const FIRMWARE_CRC_POLY = 0x1021;

            const AM_FIRMWARE_TOTAL_SIZE = 240 * 1024;

            function updateCRC (crc, incr) {

                const xor = crc >> 15;

                let out = (crc << 1) & 0xFFFF;

                if (incr) out = (out + 1) & 0xFFFF;

                if (xor) out ^= FIRMWARE_CRC_POLY;

                return out;

            }

            expectedCRC = 0;

            for (let i = 0; i < AM_FIRMWARE_TOTAL_SIZE; i += 1) {

                const byte = i < firmwareData.length ? firmwareData[i] : 0xFF;

                for (let j = 0x80; j > 0; j >>= 1) expectedCRC = updateCRC(expectedCRC, byte & j);

            }

            for (let j = 0; j < 16; j += 1) expectedCRC = updateCRC(expectedCRC, 0);

            expectedCRC = ('0000' + expectedCRC.toString(16).toUpperCase()).slice(-4);

        }

        electronLog.log('Comparing CRC to expected value');

        result = await callWithRetry(sendPacketToUSBHIDBootloader, [AM_BOOTLOADER_CALC_SRAM_FIRMWARE_CRC], DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

        if (result[1] !== AM_BOOTLOADER_CALC_SRAM_FIRMWARE_CRC) {

            throw ('Did not get correct response from AudioMoth.');

        }

        /* Get CRC value */

        let retries = 0;

        while (retries < MAXIMUM_RETRIES) {

            /* Wait for CRC calculation */

            await delay(DEFAULT_DELAY_BETWEEN_CRC_REQUESTS);

            /* Try to access CRC value */

            result = await callWithRetry(sendPacketToUSBHIDBootloader, [AM_BOOTLOADER_GET_FIRMWARE_CRC], DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

            if (result[1] !== AM_BOOTLOADER_GET_FIRMWARE_CRC) {

                throw ('Did not get correct response from AudioMoth.');

            }

            if (result[2] === 0x01) {

                break;

            }

            retries += 1;

        }

        if (retries === MAXIMUM_RETRIES) {

            throw ('AudioMoth did not calculate CRC.');

        }

        let actualCRC = result[3] + (result[4] << 8);

        actualCRC = ('0000' + actualCRC.toString(16).toUpperCase()).slice(-4);

        electronLog.log('Actual CRC: 0x' + actualCRC);
        electronLog.log('Expected CRC: 0x' + expectedCRC);

        if (actualCRC !== expectedCRC) {

            throw ('Calculated CRC does not match expected value. ' + actualCRC + ' !== ' + expectedCRC);

        }

        /* Clear user data */

        if (clearUserData) {

            electronLog.log('Clearing user data');

            result = await callWithRetry(sendPacketToUSBHIDBootloader, [AM_BOOTLOADER_CLEAR_USER_DATA], DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

            if (result[1] !== AM_BOOTLOADER_CLEAR_USER_DATA) {

                throw ('Did not get correct response from AudioMoth.');

            }

            if (result[2] !== 0x01) {

                throw ('AudioMoth did not clear user data.');

            }

        }

        /* Flash firmware */

        electronLog.log('Flashing');

        result = await callWithRetry(sendPacketToUSBHIDBootloader, [AM_BOOTLOADER_FLASH_FIRMWARE], DEFAULT_RETRY_INTERVAL, MAXIMUM_RETRIES);

        if (result[1] !== AM_BOOTLOADER_FLASH_FIRMWARE) {

            throw ('Did not get correct response from AudioMoth.');

        }

        if (result[2] !== 0x01) {

            throw ('AudioMoth did not respond to flash request.');

        }

        let successMessage = 'Firmware has been successfully updated.';
        successMessage = actualCRC ? successMessage + '\nFlash CRC: ' + actualCRC : successMessage;

        electron.ipcRenderer.send('set-bar-restarting', RESET_TIMEOUT_LENGTH);
        resetTime = 0;
        restartTimer(successMessage, successCallback);

    } catch (exception) {

        failureCallback(exception);

    }

}

exports.USBHIDFlash = USBHIDFlash;
