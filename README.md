# Class Booking System

初版 — 核心功能实现。学生可在线预约课程，自动写入 Google 日历和表格。

## 功能

- 📅 按日期查看可预约时段
- ✅ 选择时间并提交预约
- 📧 自动发送确认邮件（通过 Google Calendar）
- 📊 预约记录写入 Google Sheets

## 技术栈

- 前端：纯 HTML / CSS / JS（无框架）
- 后端：Netlify Functions (Node.js)
- API：Google Calendar API + Google Sheets API
- 部署：Netlify

## 本地开发

```bash
# 安装依赖
npm install

# 启动 Netlify 本地环境
netlify dev
```

## 环境变量

复制 `.env.example` 为 `.env`，填写实际值：

```bash
cp .env.example .env
```

在 Netlify 上部署时，需在 **Site Settings → Environment Variables** 中配置相同变量。

## 目录结构

```
index.html              # 主页（课程介绍）
booking.html           # 预约页面
netlify/
  functions/
    availability.js    # 查询可预约时段
    book.js            # 提交预约
package.json
netlify.toml          # Netlify 配置
```

## 状态

当前为初版（MVP），核心预约流程可用。后续计划：
- 学生端账号系统
- 老师端管理界面
- 邮件提醒优化
