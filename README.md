# Remote Control 遠端桌面

用三星平板、手機或另一台電腦的瀏覽器觀看桌面，取得主機同意後即可使用鍵盤、滑鼠、觸控板或觸控螢幕操作。電腦要反向觀看 Android 手機或平板時，在 Android 裝置上啟動本專案的螢幕分享 App。這是獨立開發的自架軟體，畫質選項和連線人數都沒有訂閱費。

## 選擇連線方向

| 你想做的事 | 在被分享的裝置上 | 在觀看裝置上 |
| --- | --- | --- |
| 三星平板、手機或電腦操作 Windows | 啟動 Windows 主機，分享整個主螢幕並授權操作 | 用瀏覽器開啟觀看網址、輸入連線碼 |
| 三星平板、手機或電腦操作 Mac | 啟動桌面服務，授權瀏覽器錄製螢幕、授權啟動服務的程式使用「輔助使用」 | 使用相同的觀看網頁 |
| 操作 Linux 桌面 | 在單螢幕的原生 X11 工作階段啟動服務 | 使用相同的觀看網頁 |
| 電腦觀看 Android 手機或平板 | 安裝 Android 分享 App，同意系統投放提示 | 開啟手機顯示的 HTTPS 網址，核對憑證並配對 |

Windows、macOS 和 Linux 主機都透過桌面瀏覽器的螢幕選擇器分享。分頁或單一視窗可供觀看。要授予遠端輸入，請使用單螢幕桌面並選取整個主螢幕。Wayland 支援度依瀏覽器的擷取能力而定，目前僅提供觀看。Android 與 iOS 的瀏覽器可作為桌面的觀看端；手機分享端提供 Android 版本。

## 在 Windows 或 Mac 啟動

**Windows 免安裝版**可從此分支通過的 GitHub Actions「Build and test」執行頁面下載 `Windows-desktop-host`，解壓縮後執行 `RemoteControlHost.exe`。選擇這台電腦的區網 IPv4 位址；例如電腦是 `192.168.1.20`，平板就開啟 `https://192.168.1.20:8443/`。請保持啟動視窗開啟。[建置與下載](https://github.com/blizzard-new/remote_control/actions?query=workflow%3A%22Build+and+test%22)

**在 Mac 或其他電腦上從原始碼啟動**，請使用 Python 3.11 以上版本，在專案目錄執行以下指令。將範例 IP 換成被控制電腦的 Wi-Fi 或乙太網路 IPv4 位址。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/start_lan.py 192.168.1.20 --request-control
```

在 Mac 的「系統設定 → 隱私權與安全性」中，於「螢幕與系統音訊錄製」（部分版本稱為「螢幕錄製」）允許用來分享的瀏覽器，並於「輔助使用」允許實際啟動服務的程式，例如 Terminal、iTerm 或 Python。依 macOS 提示重新開啟程式再分享。Retina 的游標位置依畫面比例換算。

Windows PowerShell 可用以下指令從原始碼啟動。

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts/start_lan.py 192.168.1.20
```

Linux 使用與 Mac 相同的 Python 指令，省略 `--request-control`。啟用原生 X11 輸入需要 `libX11`、`libXtst`、`libXrandr` 及 `xkbcomp`。

### 讓平板或另一台電腦連入

1. 首次啟動會產生專屬的區網 HTTPS 憑證。把啟動視窗指定的 **trusted-root.crt** 放到主機與觀看裝置上，核對顯示的 SHA-256 指紋後加入信任。Windows 可匯入「目前使用者 → 受信任的根憑證授權單位」，Mac 可在「鑰匙圈存取」中匯入並信任該根憑證，三星平板可在設定搜尋「安裝 CA 憑證」。私鑰 `server.key` 留在主機。若已有可信任的伺服器憑證，可改用下方的自訂啟動指令。
2. 在被控制的電腦開啟終端機顯示、含 `#host=` 的本機專用連結，選擇畫面並開始分享。其他裝置只需要觀看網址與分享頁上的連線碼。如果手機連不上，確認兩台裝置能互連且主機的防火牆允許區網連入 TCP 8443。
3. 在三星平板的 Chrome 或另一台裝置的瀏覽器開啟觀看網址，輸入名稱及連線碼。在被控制的電腦按「允許觀看」或授予操作。每位觀看者都有獨立連線，可個別中斷；每次最多 16 個等待中或已核准的裝置，同時由一台裝置操作。
4. 操作時把游標放在遠端畫面上。三星鍵盤觸控板的上下與左右捲動皆保留細微滑動量。直接觸控時可單指拖曳、雙指捲動。在主機上停止分享或關閉分享分頁，會結束所有連線。

### 畫質、隱私與對外連線

- **桌面畫質**預設目標為 1080p / 60 fps，可選 720p / 30 fps、1080p / 30 fps、1440p / 120 fps 或 4K / 60 fps。觀看頁顯示實際影像尺寸，以及瀏覽器提供的實測幀率。編碼能力、來源畫面更新頻率、網路與觀看人數都會影響結果。來源支援時也能選擇分享音訊。
- **Windows 隱私模式**適用於單螢幕的一般桌面，需 Windows 10 2004 或更新版本。主機先授權該控制端使用隱私模式，再開啟本機黑色遮罩。請同時確認實體螢幕變暗、觀看端仍顯示持續更新的畫面。本機按 **Ctrl + Alt + Shift + F10** 可立即恢復。控制端斷線時服務會釋放按鍵並移除遮罩。鎖定、登入與 UAC 安全桌面另由 Windows 管理。Mac 與 Linux 目前提供遠端操作，隱私遮罩限 Windows。
- **跨網路**可使用讓雙方互通的私人 VPN，或以主機可達的 HTTPS/WSS 位址連線。受限 NAT 或企業網路可能需要自備 TURN 中繼；將 WebRTC 的 ICE 伺服器清單以 JSON 設定在 `REMOTE_ICE_SERVERS`，例如 `[{"urls":"turns:turn.example.com:5349","username":"使用者","credential":"短期憑證"}]`。開放 TURN 不能代替觀看端到 HTTPS 服務的可達性。每位觀看者各用一路 WebRTC，主機上傳用量會隨人數增加。
- **自行提供 TLS 憑證**可執行 `python -m server --bind 0.0.0.0 --port 8443 --cert chain.pem --key server.key`。若只在同一台電腦測試，可執行 `python -m server`，以主機專用連結與另一個瀏覽器分頁配對。

## 從電腦觀看手機或平板

Android 8.0 以上可安裝此專案的 `Android-screen-host` 測試版 APK，或用 Android Studio 開啟 `android/` 建置。啟動 App、選擇分享品質並同意 Android 的系統提示，再在電腦瀏覽器輸入手機顯示的網址及配對碼。手機可從通知列隨時停止分享。連線支援同一 Wi-Fi 或已有路由的私人 VPN。詳見[配對、影像格式與安裝步驟](android/README.md)。

## 開發與驗證

桌面服務使用 Python、aiohttp 和系統原生輸入 API。網頁使用標準 WebRTC，無需打包 JavaScript。Android 使用 MediaProjection、前景服務與 Android Keystore。CI 在 Linux、Windows、macOS 測試桌面程式，並建置 Windows 主機執行檔及 Android 測試 APK。

```sh
python -m unittest discover -s tests -v
node --test tests/input.test.mjs android/tests/avc-player.test.mjs
python -m pip install playwright
python -m playwright install chromium
python -m unittest discover -s tests -p browser_smoke.py -v
cd android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

瀏覽器整合測試使用合成畫面，讓兩個觀看端透過真正的 WebRTC 解碼並驗證像素，再驗證控制端捲動、撤銷操作、另一台裝置繼續觀看及停止分享。實機驗收時，請用三星鍵盤觸控板在長網頁慢速垂直捲動、在寬表格水平捲動，並在主機開啟隱私模式後從旁確認實體螢幕的狀態。

此版本優先實作跨裝置觀看、桌面控制、多人連線與 Windows 隱私。DeskIn 的付費功能還包含虛擬顯示器、4:4:4 色彩、繪圖板、遊戲控制器與巨集等，本專案目前尚未提供這些功能。[DeskIn 個人版功能表](https://deskin.io/pricing/deskin-personal)
