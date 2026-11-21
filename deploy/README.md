# 把 remote.uniway-tw.com 接到既有主機

此部署供擁有 `uniway-tw.com` 與 demo 主機管理權的人使用。下載頁由 GitHub Releases 提供，配對與無法直連時的畫面轉送由這台 Caddy 主機提供。兩端都向外建立加密 WebSocket 連線，觀看端不必開放家用路由器的連接埠。

1. 在 Cloudflare 選 **uniway-tw.com → DNS → Records → Add record**。類型選 **CNAME**，名稱填 **remote**，目標填 **demo.uniway-tw.com**，Proxy status 選 **DNS only**，TTL 選 **Auto**。此設定會跟著 demo 的位址變更。只在兩個服務確定使用同一台主機時這樣填。
2. 在運行 Caddy 的主機上，以可使用 Docker Compose 的帳號執行以下指令。若已有此專案的檢出目錄，可在另一個目錄檢出這個版本。

   ```sh
   git clone --branch v0.2.0 https://github.com/blizzard-new/remote_control.git remote-control-relay
   cd remote-control-relay
   docker compose -f deploy/compose.yaml up -d --build
   curl --fail http://127.0.0.1:8788/health
   ```

3. 如果 Caddy 直接在主機上運行，把 [Caddyfile.remote](Caddyfile.remote) 的獨立站點區塊加入目前載入的 Caddy 設定，保留現有 demo 站點。使用系統服務與預設路徑時，可執行 `sudo caddy validate --config /etc/caddy/Caddyfile`，成功後執行 `sudo systemctl reload caddy`。Caddy 會自動申請 HTTPS 憑證並代理 WebSocket。
4. 如果既有 Caddy 在容器裡，讓它和 `remote-relay` 加入同一 Docker network，在該容器載入的設定裡將上游改成 `remote-relay:10000`，再按原本的部署方式 reload。容器內的 loopback 只指向容器本身。
5. 在其他網路執行 `curl --fail https://remote.uniway-tw.com/health`，應取得含有 `"service":"remote-control"` 與 `"protocol":1` 的 JSON。造訪根網址會開啟 GitHub 下載頁。最後讓電腦接 Wi-Fi、手機改用行動數據，在分享端產生邀請碼並實際核准一次。

用其他主機名稱時，請在分享端的配對服務設定填入該 HTTPS 網址。邀請碼會帶入服務位置。服務只在記憶體中保存連線，每個邀請最多 8 個觀看端；服務重啟時需重新分享。WebRTC 能直接連接的桌面會使用直接影像；影像中繼會消耗主機頻寬。
