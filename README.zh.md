<div align="center">

<img src="docs/images/hero.svg" alt="Hydrogen — 自托管 LLM 代理" width="100%">

# 中文文档（施工中）

</div>

中文版 README 尚未翻译完成。在此之前请阅读 **[英文 README](README.md)**。

已有的中文文档：

- **[快速上手指南](docs/getting-started.zh.md)** —— 从零到第一次 API 调用，并附带 Micro Agent（微代理）的完整示例。

部署方式一览（详见英文 README 的 [Deployment](README.md#deployment) 一节）：

1. **雨云应用商店** —— 在 [雨云应用商店](https://app.rainyun.com/apps/rca/store) 搜索 **Hydrogen**，一键部署；注意保留模板自带的 `/data` 持久化存储。
2. **容器镜像** —— `ghcr.io/arrosam/hydrogen-llm-proxy:v1.5.2`，可用 [`deploy/vps/`](deploy/vps) 中的 compose 配置直接跑在任意 VPS 上。
3. **源码构建** —— `git clone` 之后 `docker compose up -d --build`。

> 还没有雨云账号？可通过[邀请链接](https://www.rainyun.com/MTA1NzAwNA==_)注册。
