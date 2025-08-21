Package into .exe

Install Electron Packager:

npm install --save-dev electron-packager


Build Windows executable:

npx electron-packager . whatsapp-exporter --platform=win32 --arch=x64 --out=dist --overwrite

After build,
inside dist need to add Chrome folder inside resource/app