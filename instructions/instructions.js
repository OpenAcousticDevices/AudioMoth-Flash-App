/****************************************************************************
 * instructions.js
 * openacousticdevices.info
 * December 2019
 *****************************************************************************/

'use strict';

/* global document */

const electron = require('electron');

const comms = require('../communication.js');

var stepDivs = document.getElementsByClassName('step-div');
var buttonDivs = document.getElementsByClassName('button-div');

var step0Button0 = document.getElementById('step0-button0');
var step0Button1 = document.getElementById('step0-button1');

var step1Button0 = document.getElementById('step1-button0');

var step2Button0 = document.getElementById('step2-button0');
var step2Button1 = document.getElementById('step2-button1');

var step3Button0 = document.getElementById('step3-button0');

var step4Button0 = document.getElementById('step4-button0');

var backLink = document.getElementById('back-link');
var disabledBackLink = document.getElementById('disabled-back-link');

var connectionDiv = document.getElementById('connection-div');

var currentIndex = 0;
var previousIndexes = [];

var customSwitchImages = [document.getElementById('custom-switch-flash0'), document.getElementById('custom-switch-flash1')];
var visibleFrame = 0;

function flashLEDs () {

    visibleFrame++;

    customSwitchImages[visibleFrame % 2].style.display = '';
    customSwitchImages[(visibleFrame + 1) % 2].style.display = 'none';

    setTimeout(flashLEDs, 500);

}

electron.ipcRenderer.on('status-instructions', (event, status) => {

    switch (status) {

    case comms.STATUS_USB_DRIVE_BOOTLOADER:
        connectionDiv.innerHTML = 'Found AudioMoth in flash mode with a USB drive bootloader.';
        connectionDiv.style.color = 'green';
        step3Button0.disabled = false;
        break;

    case comms.STATUS_SERIAL_BOOTLOADER:
        connectionDiv.innerHTML = 'Found AudioMoth in flash mode with a serial bootloader.';
        connectionDiv.style.color = 'green';
        step3Button0.disabled = false;
        break;

    case comms.STATUS_NO_AUDIOMOTH:
        connectionDiv.innerHTML = 'No AudioMoth found.';
        connectionDiv.style.color = 'red';
        step3Button0.disabled = true;
        break;

    case comms.STATUS_AUDIOMOTH_AUTO:
        connectionDiv.innerHTML = 'Found an AudioMoth with firmware which supports automatic flash mode switching installed.';
        connectionDiv.style.color = 'green';
        step3Button0.disabled = false;
        break;

    case comms.STATUS_AUDIOMOTH_MANUAL:
        connectionDiv.innerHTML = 'Found an AudioMoth with firmware which does not support automatic flash mode switching. ';
        connectionDiv.innerHTML += 'Follow instructions to manually switch.';
        connectionDiv.style.color = 'red';
        step3Button0.disabled = true;
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

}

function addButtonListener (button, targetIndex) {

    button.addEventListener('click', () => {

        previousIndexes.push(currentIndex);
        currentIndex = targetIndex;

        updateUI();

    });

}

function setUpButtons () {

    addButtonListener(step0Button0, 1);
    addButtonListener(step0Button1, 2);

    addButtonListener(step1Button0, 3);

    addButtonListener(step2Button0, 1);
    addButtonListener(step2Button1, 3);

    addButtonListener(step3Button0, 4);

    step4Button0.addEventListener('click', () => {

        electron.remote.getCurrentWindow().close();

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
