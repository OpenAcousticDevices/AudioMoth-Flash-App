/****************************************************************************
 * progressBar.js
 * openacousticdevices.info
 * May 2026
 *****************************************************************************/

'use strict';

const electron = require('electron');

let progressBarMaxValue = 100;
let progressBarCurrentValue = 0;

const progressBarWindowTitleElement = document.getElementById('progress-bar-window-title');
const progressBarHeadingElement = document.getElementById('progress-bar-heading');
const progressBarDetailElement = document.getElementById('progress-bar-detail');
const progressBarElement = document.getElementById('progress-bar');

function createProgressBar (windowTitle, heading, detail, maxValue) {

    progressBarMaxValue = maxValue;
    progressBarCurrentValue = 0;

    progressBarWindowTitleElement.textContent = windowTitle;
    progressBarHeadingElement.textContent = heading;
    progressBarDetailElement.textContent = detail;
    progressBarElement.style.width = '0%';

}

function setProgressBarValue (value) {

    value = Math.min(value, progressBarMaxValue);

    progressBarCurrentValue = value;
    const percentage = (progressBarCurrentValue / progressBarMaxValue) * 100;
    progressBarElement.style.width = `${percentage}%`;

}

function setDetailText (detail) {

    console.log(`Setting detail ${detail}`);

    progressBarDetailElement.textContent = detail;

}

function setHeadingText (heading) {

    progressBarHeadingElement.textContent = heading;

}

function setWindowTitle (windowTitle) {

    progressBarWindowTitleElement.textContent = windowTitle;

}

electron.ipcRenderer.on('create-progress-bar', (event, {windowTitle, heading, detail, maxValue}) => {

    createProgressBar(windowTitle, heading, detail, maxValue);

});

electron.ipcRenderer.on('set-progress-bar-value', (event, value) => {

    setProgressBarValue(value);

});

electron.ipcRenderer.on('set-progress-bar-detail', (event, detail) => {

    setDetailText(detail);

});

electron.ipcRenderer.on('set-progress-bar-heading', (event, heading) => {

    setHeadingText(heading);

});

electron.ipcRenderer.on('set-progress-bar-window-title', (event, windowTitle) => {

    setWindowTitle(windowTitle);

});
