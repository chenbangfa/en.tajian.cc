# 英语学习平台 - 后端服务

## 技术栈
- Node.js + Express
- MySQL
- 集成：Google Gemini AI、有道API、腾讯云语音评测

## 安装
```bash
npm install
```

## 配置
复制 `.env.example` 为 `.env` 并填写配置：
```bash
cp .env.example .env
```

## 运行
```bash
# 主API服务 (端口3000)
npm run dev

# 管理后台 (端口3002)
npm run admin:dev

# 生产环境
npm start
```

## API接口
- 主服务: http://localhost:3000/api
- 管理后台: http://localhost:3002

## 数据库
```bash
mysql -u root -p < database/schema.sql
```
