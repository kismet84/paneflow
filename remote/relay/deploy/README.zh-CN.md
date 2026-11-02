# Codex Pane Relay 部署包

本目录是可独立上传的 Relay 部署包，不包含 Codex Pane 桌面应用和手机业务界面。

## 部署

需要 Docker 和 Compose。

1. 将域名解析到服务器并开放 TCP 443。TCP 80 未被占用时一并开放；UDP 443 可选。
2. 将 `.env.example` 复制为 `.env`，把 `PANE_DOMAIN` 改为不带协议和路径的域名。Relay 使用根路径时保留 `PANE_BASE_PATH=/`；需要复用现有域名时可配置为 `/codex-pane-relay` 等路径。
3. 运行：

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f
```

4. 按配置访问健康检查：根路径使用 `https://<你的域名>/health`，路径部署使用 `https://<你的域名>/codex-pane-relay/health`。
5. 在 Codex Pane 的“设置 → 远程访问”中填写中转服务的基础地址：根路径使用 `https://<你的域名>`，路径部署使用 `https://<你的域名>/codex-pane-relay`。

如果服务器已有 HTTPS 入口，运行 `docker compose -f docker-compose.proxy.yml up -d --build`，Relay 将只监听 `127.0.0.1:8787`。现有反向代理必须保留请求路径，将配置的路径前缀转发到该端口。

Nginx 示例：

```nginx
location = /codex-pane-relay {
    return 301 /codex-pane-relay/;
}

location /codex-pane-relay/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

`proxy_pass` 地址末尾不要添加 `/`，否则 Nginx 会剥离 Relay 所需的路径前缀。

更新时替换部署包并保留 `.env`，再次运行所选部署方式的 Compose 启动命令。
