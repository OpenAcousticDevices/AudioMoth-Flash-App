/****************************************************************************
 * instructions.js
 * openacousticdevices.info
 * December 2019
 *****************************************************************************/

'use strict';

/* global document */

const electron = require('electron');
const {getCurrentWindow} = require('@electron/remote');

const comms = require('../communication.js');
const nightMode = require('../nightMode.js');

const stepDivs = document.getElementsByClassName('step-div');
const buttonDivs = document.getElementsByClassName('button-div');

const STEP_CONNECT_AUDIOMOTH = 0;
const step0Button0 = document.getElementById('step0-button0');
const step0Button1 = document.getElementById('step0-button1');

const STEP_POWER_INTO_SERIAL_FLASH_MODE = 1;
const step1Button0 = document.getElementById('step1-button0');

const STEP_VERIFY_CONNECTION_1 = 2;
const step2Button0 = document.getElementById('step2-button0');

const STEP_ENABLE_SERIAL_FLASH_MODE = 3;
const step3Button0 = document.getElementById('step3-button0');
const step3Button1 = document.getElementById('step3-button1');

const STEP_VERIFY_CONNECTION_2 = 4;
const step4Button0 = document.getElementById('step4-button0');

const STEP_SET_SWITCH = 5;
const step5Button0 = document.getElementById('step5-button0');

const backLink = document.getElementById('back-link');
const disabledBackLink = document.getElementById('disabled-back-link');

const connectionDiv = document.getElementById('connection-div');

const statusRow = document.getElementById('status-row');

let currentIndex = STEP_CONNECT_AUDIOMOTH;
let previousIndexes = [];

const customSwitchImages = [document.getElementById('custom-switch-flash0'), document.getElementById('custom-switch-flash1')];
let visibleFrame = 0;

electron.ipcRenderer.on('night-mode', (e, nm) => {

    if (nm !== undefined) {

        nightMode.setNightMode(nm);

    } else {

        nightMode.toggle();

    }

});

function flashLEDs () {

    visibleFrame++;

    customSwitchImages[visibleFrame % 2].style.display = '';
    customSwitchImages[(visibleFrame + 1) % 2].style.display = 'none';

    setTimeout(flashLEDs, 500);

}

electron.ipcRenderer.on('status-instructions', (event, status) => {

    switch (status) {

    case comms.STATUS_SERIAL_BOOTLOADER:
        connectionDiv.innerHTML = 'Found an AudioMoth in serial flash mode.';
        connectionDiv.style.color = 'green';
        step2Button0.disabled = false;
        step4Button0.disabled = false;
        break;

    case comms.STATUS_NO_AUDIOMOTH:
        connectionDiv.innerHTML = 'No AudioMoth found.';
        connectionDiv.style.color = 'red';
        step2Button0.disabled = true;
        step4Button0.disabled = true;
        break;

    case comms.STATUS_AUDIOMOTH_AUTO:
        connectionDiv.innerHTML = 'Found an AudioMoth that will automatically switch to serial flash mode.';
        connectionDiv.style.color = 'green';
        step2Button0.disabled = false;
        step4Button0.disabled = false;
        break;

    case comms.STATUS_AUDIOMOTH_MANUAL:
        connectionDiv.innerHTML = 'Found an AudioMoth which must be manually switched to serial flash mode.';
        connectionDiv.style.color = 'red';
        step2Button0.disabled = true;
        step4Button0.disabled = true;
        break;

    case comms.STATUS_AUDIOMOTH_USB:
        connectionDiv.innerHTML = 'Found an AudioMoth that will use USB HID flashing.';
        connectionDiv.style.color = 'green';
        step2Button0.disabled = false;
        step4Button0.disabled = false;
        break;

    }

});

function updateUI () {

    for (let i = 0; i < stepDivs.length; i++) {

        stepDivs[i].style.display = (i === currentIndex) ? '' : 'none';
        buttonDivs[i].style.display = (i === currentIndex) ? '' : 'none';

    }

    backLink.style.display = (currentIndex === 0) ? 'none' : '';
    disabledBackLink.style.display = (currentIndex === 0) ? '' : 'none';

    statusRow.style.display = (currentIndex === STEP_VERIFY_CONNECTION_1 || currentIndex === STEP_VERIFY_CONNECTION_2) ? '' : 'none';

}

function addButtonListener (button, targetIndex) {

    button.addEventListener('click', () => {

        previousIndexes.push(currentIndex);
        currentIndex = targetIndex;

        updateUI();

    });

}

function setUpButtons () {

    addButtonListener(step0Button0, STEP_POWER_INTO_SERIAL_FLASH_MODE);
    addButtonListener(step0Button1, STEP_ENABLE_SERIAL_FLASH_MODE);

    addButtonListener(step1Button0, STEP_VERIFY_CONNECTION_1);

    addButtonListener(step2Button0, STEP_SET_SWITCH);

    addButtonListener(step3Button0, STEP_POWER_INTO_SERIAL_FLASH_MODE);
    addButtonListener(step3Button1, STEP_VERIFY_CONNECTION_2);

    addButtonListener(step4Button0, STEP_SET_SWITCH);

    step5Button0.addEventListener('click', () => {

        currentIndex = 0;
        previousIndexes = [0];
        updateUI();

        getCurrentWindow().close();

    });

    backLink.addEventListener('click', () => {

        if (currentIndex === 0) {

            previousIndexes = [0];

        }

        currentIndex = previousIndexes.pop();

        updateUI();

    });

}

setUpButtons();
setTimeout(flashLEDs, 500);
updateUI();
