# Remote Control 遠端桌面

Windows、Mac 與 Android 可以互相連線。手機可用觸控、滑鼠及鍵盤操作電腦，電腦也可點擊、長按、拖曳和捲動手機畫面。第一次配對輸入四位數，後續可直接點選已配對的裝置。

[桌面裝置中心](docs/device-center.png) · [手機裝置詳情](docs/device-detail-mobile.png)

## 下載與跨網路連線

用手機、平板或電腦開啟同一個[下載頁](https://github.com/blizzard-new/remote_control/releases/latest)。Windows 選擇 Setup 安裝檔。Mac 的「關於這台 Mac」若顯示 Apple M 系列，選 arm64，Intel 則選 x86_64。下載相符的 PKG 安裝到「應用程式」。Android 下載 APK 後安裝。

1. 安裝 0.5.4 後，Android 啟動後直接進入裝置列表。「目前連線」只計入已獲准、仍在進行的連線。舊版沒有辨識名稱的配對會單獨收在「舊版配對紀錄」。「新增連線」可輸入另一台裝置的四位數，輸入最後一碼即送出。首次在被控端核對識別字串，選「允許操作」或「允許觀看」。這個選擇也決定後續可直接重連的權限。
2. 第二次在裝置列表點對方名稱，再按「遠端控制」或「觀看模式」。雙方保有配對紀錄且主機待命時，會依該裝置先前獲准的權限直接連線。兩端使用 0.5.3 或更新版本時，重新輸入對方目前的四碼也會辨識已有的配對。交換控制方向或把觀看升級為操作時，由新被控端首次授權。可在被控端點「解除配對」撤銷信任。
3. 手機控制 Windows 或 Mac 會自動進入全螢幕。點選可辨識的遠端文字欄位會開啟手機鍵盤，支援中文選字。自繪輸入欄可按工具列的鍵盤圖示。Mac 首次需同意螢幕錄製與輔助使用。電腦控制 Android 時，在手機裝置列表點「我的手機連線碼」，把顯示的四碼輸入電腦。在手機啟用「遠端桌面觸控操作」，按「開放整個螢幕連線」，完成 Android 的螢幕分享授權並對這台電腦選「允許操作」。分享期間，這台電腦中斷再連會沿用授權。停止分享後，下一次開始分享仍需確認 Android 的系統提示。
4. 畫面右上角可選 540p、720p、1080p，以及目標 30 或 60 fps。選單會顯示實收尺寸和幀率。Android 跨網路分享在接收端支援時使用 H.264。編解碼器無法使用，或多個觀看者選擇不同規格時，會改用逐裝置調整的 JPEG。桌面優先嘗試 WebRTC，並提供 JPEG 中繼。實際幀率取決於螢幕更新、編碼速度與頻寬。

如果 Mac 的「目前連線」顯示手機「正在觀看本機」，點手機旁的「觀看手機畫面」即可切換觀看方向。手機出現邀請時，點「切換為分享手機」和「開放整個螢幕連線」，依 Android 的提示開始分享，再切到想在 Mac 上看的 App。Mac 會顯示連線進度和接收到的畫面。Mac 只觀看手機時，無需授予 Mac 螢幕錄製或輔助使用權限。

若手機已配對卻無法操控 Mac，請喚醒 Mac，開啟「應用程式」裡的 RemoteControl。在「進階設定」按「重新讀取權限」，可核對正在執行的 App 路徑和 macOS 回報的螢幕錄製、輔助使用、鍵鼠事件權限。如果系統設定已開啟兩個開關，但目前程序仍未取得權限，可按「重新開啟 RemoteControl」，再從手機點原配對重連。

自 0.4.0 起，桌面控制頁與 Android 首頁會在開啟時檢查 GitHub 正式版，也可按「檢查更新」。有新版時按「立即更新」，程式會下載此裝置的安裝檔，比對 SHA-256 並開啟系統安裝程式。Android 也會比對 App 簽章。首次從 0.3.0 升級需使用下載頁。

預設服務網址為 `https://remote.uniway-tw.com`。自架使用其他服務時，請在兩端的進階設定填相同 HTTPS 網址。[服務部署說明](deploy/README.md)

若出現作業系統或瀏覽器的安裝提示，可先核對 Releases 裡的 SHA-256。Mac App 採 ad hoc 簽署，首次開啟可能需要在「系統設定 → 隱私權與安全性」允許；Windows 尚未採用商業程式碼簽章。從舊的 debug APK 改裝發行版，如 Android 回報簽章不同，先解除安裝舊的測試版。

## 選擇連線方向

| 你想做的事 | 在被分享的裝置上 | 在觀看裝置上 |
| --- | --- | --- |
| 三星平板、手機或電腦操作 Windows | 啟動 Windows 主機，分享整個主螢幕並授權操作 | 用瀏覽器開啟觀看網址、輸入連線碼 |
| 三星平板、手機或電腦操作 Mac | 啟動桌面服務，授權瀏覽器錄製螢幕、授權啟動服務的程式使用「輔助使用」 | 使用相同的觀看網頁 |
| 操作 Linux 桌面 | 在單螢幕的原生 X11 工作階段啟動服務 | 使用相同的觀看網頁 |
| 電腦操作 Android 手機或平板 | 開啟觸控操作、分享螢幕並授權電腦 | 輸入四碼或點選已配對的手機 |

進階區網模式下，Windows、macOS 和 Linux 主機可用桌面版 Chrome 或 Edge，透過瀏覽器的螢幕選擇器分享。分頁或單一視窗可供觀看。要授予遠端輸入，請使用單螢幕桌面並選取整個主螢幕。Wayland 支援度依瀏覽器的擷取能力而定，目前僅提供觀看。Android 與 iOS 的瀏覽器可作為桌面的觀看端；手機分享端提供 Android 版本。

## 在 Windows 或 Mac 啟動

直接開啟桌面版會進入跨網路模式。本機控制頁優先使用 8443，若已被占用，程式會自動改用可用的連接埠並開啟正確的網址。

**區網專用模式**可用 `.\RemoteControl-Windows-x64.exe --lan` 啟動。選擇這台電腦的區網 IPv4 位址；例如電腦是 `192.168.1.20`，平板就開啟 `https://192.168.1.20:8443/`。請保持啟動視窗開啟。[建置與下載](https://github.com/blizzard-new/remote_control/actions?query=workflow%3A%22Build+and+test%22)

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
3. 在三星平板上，可用 Android App 的「連接電腦」開啟觀看網址；其他裝置可用瀏覽器。輸入裝置名稱及連線碼。在被控制的電腦按「允許觀看」或授予操作。每位觀看者都有獨立連線，可個別中斷；每次最多 16 個等待中或已核准的裝置，同時由一台裝置操作。
4. 操作時把游標放在遠端畫面上。Android App 可直接讀取三星鍵盤觸控板的水平與垂直捲動軸。若用 Chrome 則接收瀏覽器的滾輪事件，兩種方式都會保留細微滑動量。直接觸控時可單指拖曳、雙指捲動。在主機上停止分享或關閉分享分頁，會結束所有連線。

### 畫質、隱私與對外連線

- **桌面畫質**預設目標為 1080p / 60 fps，可選 720p / 30 fps、1080p / 30 fps、1440p / 120 fps 或 4K / 60 fps。觀看頁顯示實際影像尺寸，以及瀏覽器提供的實測幀率。編碼能力、來源畫面更新頻率、網路與觀看人數都會影響結果。來源支援時也能選擇分享音訊。
- **Windows 隱私模式**適用於單螢幕的一般桌面，需 Windows 10 2004 或更新版本。主機先授權該控制端使用隱私模式，再開啟本機黑色遮罩。請同時確認實體螢幕變暗、觀看端仍顯示持續更新的畫面。本機按 **Ctrl + Alt + Shift + F10** 可立即恢復。控制端斷線時服務會釋放按鍵並移除遮罩。鎖定、登入與 UAC 安全桌面另由 Windows 管理。Mac 與 Linux 目前提供遠端操作，隱私遮罩限 Windows。
- **跨網路**可使用讓雙方互通的私人 VPN，或以主機可達的 HTTPS/WSS 位址連線。受限 NAT 或企業網路可能需要自備 TURN 中繼；將 WebRTC 的 ICE 伺服器清單以 JSON 設定在 `REMOTE_ICE_SERVERS`，例如 `[{"urls":"turns:turn.example.com:5349","username":"使用者","credential":"短期憑證"}]`。開放 TURN 不能代替觀看端到 HTTPS 服務的可達性。每位觀看者各用一路 WebRTC，主機上傳用量會隨人數增加。
- **自行提供 TLS 憑證**可執行 `python -m server --bind 0.0.0.0 --port 8443 --cert chain.pem --key server.key`。若只在同一台電腦測試，可執行 `python -m server`，以主機專用連結與另一個瀏覽器分頁配對。

## 區網專用觀看模式

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
