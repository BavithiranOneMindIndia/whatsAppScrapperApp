Package into .exe

Install Electron Packager:

npm install --save-dev electron-packager


Build Windows executable:

npx electron-packager . whatsapp-exporter --platform=win32 --arch=x64 --out=dist --overwrite

After build,
inside dist need to add Chrome folder inside resource/app


Building WhatsApp Exporter (Portable .exe with Chrome)

This project packages into a self-contained Windows portable executable.
No Node.js, npm, or Chrome needs to be installed on the client’s machine.

📂 1. Project Structure (important parts)
your-project/
├─ build/                # contains icon.ico for installer/portable exe
│   └─ icon.ico
├─ resources/            # extra files copied into packaged app
│   └─ chrome/
│      └─ win64-139.0.7258.138/
│         └─ chrome-win64/
│            ├─ chrome.exe
│            ├─ *.dll
│            ├─ icudtl.dat
│            ├─ locales/...
│            ├─ swiftshader/...
│            └─ (ALL files from that Chrome build)
├─ ui/                   # frontend HTML/JS
├─ index.js              # backend (express + whatsapp-web.js)
├─ main.js               # Electron entry
├─ package.json


👉 Important: Copy the entire extracted Chrome folder (not just chrome.exe) into
resources/chrome/win64-139.0.7258.138/chrome-win64/.

⚙️ 2. Install dependencies
npm install

🛠️ 3. Build Portable exe
npm run dist:portable


This uses electron-builder to generate a portable .exe.

📦 4. Output

After build, check dist/:

dist/
└─ WhatsApp Exporter-1.0.0-win-x64.portable.exe


Double-click to run directly.

Chrome is bundled inside the app (resources/chrome/...), so Puppeteer will not try to download or use its own .local-chromium.

✅ 5. Verify Chrome Path (first run)

On first launch, check the console log:

🔍 Custom Chrome resolved: C:\path\to\dist\win-unpacked\resources\chrome\win64-139.0.7258.138\chrome-win64\chrome.exe


If it prints (none), double-check that your resources/chrome/... folder was copied correctly and package.json has:

"extraResources": [
  { "from": "resources/", "to": ".", "filter": ["**/*"] }
]

🚀 6. Deliver to Client

Share the .portable.exe file in dist/.

Client just double-clicks, no install required.

Session data & exports are stored at:

C:\Users\<USERNAME>\whatsapp-exporter-sessions\