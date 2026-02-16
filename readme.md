# AudioMoth Flash App #
An Electron-based application capable of applying new firmware to an AudioMoth device.

For more details on the device itself, visit [www.openacousticdevices.info](http://www.openacousticdevices.info).

### Usage ###
Once the repository has been cloned, install all required dependencies with:
```
npm install
```

From then onwards, start the application with:
```
npm run start 
```

Package the application into an installer for your current platform with:
```
npm run dist [win64/win32/mac/linux]
```

This will place a packaged version of the app and an installer for the platform this command was run on into the `/dist` folder. Note that to sign the binary in macOS you will need to run the command above as 'sudo'. The codesign application will retreive the appropriate certificate from Keychain Access.

Mac applications now require notarising before distribution. For more information on notarising your app, visit the Apple support site [here](https://developer.apple.com/documentation/xcode/notarizing_macos_software_before_distribution).

For detailed usage instructions of the app itself and to download prebuilt installers of the latest stable version for all platforms, visit the app support site [here](http://www.openacousticdevices.info/config).

### Running the app on Linux ###

In order to run the app on a Linux machine, you must first set 2 udev rules which give the application the required permissions. Navigate to `/lib/udev/rules.d/` and create a new file with the name `99-audiomoth-flash.rules` containing the following:

```
SUBSYSTEM=="usb", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="0002", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="0003", MODE="0666"
```

### More Information ###

The Silicon Labs USB bootloader is described in an Application Note [here](https://www.silabs.com/documents/public/application-notes/an0042-efm32-usb-uart-bootloader.pdf).

### Related Repositories ###
* [Command line flash application](https://github.com/OpenAcousticDevices/flash)
* [AudioMoth Time App](https://github.com/OpenAcousticDevices/AudioMoth-Time-App)
* [AudioMoth Configuration App](https://github.com/OpenAcousticDevices/AudioMoth-Configuration-App)
* [AudioMoth-HID](https://github.com/OpenAcousticDevices/AudioMoth-HID)


### License ###

Copyright 2017 [Open Acoustic Devices](http://www.openacousticdevices.info/).

[MIT license](http://www.openacousticdevices.info/license).
