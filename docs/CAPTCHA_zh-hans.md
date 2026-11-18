# CAPTCHA 验证码集成文档

## 📋 概述

本项目已集成 CAP Worker 验证码服务，提供企业级的机器人防护和滥用防护功能。系统采用优雅降级策略，确保验证码服务故障时不影响核心业务。

## ⚙️ 配置说明

### 环境变量配置

在 `index.js` 的 `config` 对象中配置验证码相关参数：

```javascript
captcha: {
  enabled: true,              // 主开关：是否启用验证码服务
  api_endpoint: "https://captcha.gurl.eu.org/api",  // CAP Worker API 端点
  require_on_create: true,    // 创建短链接时是否需要验证码（默认：true）
  require_on_access: false,   // 访问短链接时是否需要验证码（默认：false）
  timeout: 5000,              // API 请求超时时间（毫秒）
  fallback_on_error: true,    // 验证码服务故障时是否允许操作（服务降级）
  max_retries: 2,             // API 调用最大重试次数
}
```

### 配置场景

#### 场景 1：默认配置（推荐）
```javascript
captcha: {
  enabled: true,
  require_on_create: true,   // 创建时需要验证码
  require_on_access: false,  // 访问时不需要验证码
  fallback_on_error: true,   // 服务故障时允许操作
}
```
**适用于**：大多数场景，防止短链接创建滥用

#### 场景 2：严格模式
```javascript
captcha: {
  enabled: true,
  require_on_create: true,   // 创建时需要验证码
  require_on_access: true,   // 访问时也需要验证码
  fallback_on_error: false,  // 服务故障时禁止操作
}
```
**适用于**：高安全要求场景，完全防护

#### 场景 3：仅访问保护
```javascript
captcha: {
  enabled: true,
  require_on_create: false,  // 创建时不需要验证码
  require_on_access: true,   // 访问时需要验证码
  fallback_on_error: true,
}
```
**适用于**：防止恶意访问和爬虫

#### 场景 4：完全禁用
```javascript
captcha: {
  enabled: false,  // 完全关闭验证码功能
}
```

## 🔧 API 使用指南

### 创建短链接（带验证码）

**前端示例**：

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://captcha.gurl.eu.org/cap.min.js"></script>
</head>
<body>
  <input type="url" id="longUrl" placeholder="输入长链接">
  <button onclick="createShortLink()">创建短链接</button>
  
  <cap-widget 
    id="cap" 
    data-cap-api-endpoint="https://captcha.gurl.eu.org/api/">
  </cap-widget>

  <div id="result"></div>

  <script>
    const widget = document.querySelector("#cap");
    let captchaToken = null;

    // 监听验证码完成事件
    widget.addEventListener("solve", function(e) {
      captchaToken = e.detail.token;
      console.log("验证码已完成");
    });

    async function createShortLink() {
      const longUrl = document.getElementById('longUrl').value;
      
      if (!captchaToken) {
        alert('请先完成验证码验证');
        return;
      }

      try {
        const response = await fetch('https://your-worker.workers.dev/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: longUrl,
            captcha_token: captchaToken  // 传递验证码 token
          })
        });

        const result = await response.json();
        
        if (result.status === 200) {
          document.getElementById('result').innerHTML = 
            `短链接: <a href="${result.key}">${result.key}</a>`;
          captchaToken = null; // 重置 token
        } else {
          alert('创建失败: ' + result.error);
          if (result.captcha_required) {
            // 需要重新验证
            captchaToken = null;
          }
        }
      } catch (error) {
        alert('请求失败: ' + error.message);
      }
    }
  </script>
</body>
</html>
```

**后端/服务端示例（Node.js）**：

```javascript
const fetch = require('node-fetch');

async function createShortLink(longUrl, captchaToken) {
  const response = await fetch('https://your-worker.workers.dev/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: longUrl,
      captcha_token: captchaToken
    })
  });

  const result = await response.json();
  
  if (result.status === 200) {
    console.log('短链接创建成功:', result.key);
    return result.key;
  } else {
    throw new Error(result.error || '创建失败');
  }
}
```

**cURL 示例**：

```bash
curl -X POST https://your-worker.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/very/long/url",
    "captcha_token": "785975238a3c4f0c1b0c39ed75e6e4cc152436cc0d94363de6"
  }'
```

### API 响应格式

**成功响应**：
```json
{
  "status": 200,
  "key": "/abc123",
  "short_url": "/abc123"
}
```

**验证码错误响应**：
```json
{
  "status": 403,
  "error": "CAPTCHA token required",
  "captcha_required": true
}
```

**验证码验证失败**：
```json
{
  "status": 403,
  "error": "Invalid or expired token",
  "captcha_required": true
}
```

## 🛡️ 服务降级策略

系统实现了多层次的服务降级机制，确保高可用性：

### 1. 重试机制
- 自动重试失败的验证码 API 调用
- 指数退避策略（100ms → 200ms → 400ms）
- 可配置最大重试次数（默认 2 次）

### 2. 超时保护
- 默认 5 秒超时
- 防止验证码服务响应缓慢影响用户体验

### 3. 优雅降级
当 `fallback_on_error: true` 时：
- 验证码服务完全不可用时，允许操作继续执行
- 记录警告日志，便于监控和排查
- 确保核心业务不受影响

### 4. 错误分类处理
- **客户端错误（400, 401, 403, 404, 409, 410）**：不重试，直接返回错误
- **服务端错误（500, 502, 503）**：重试后降级
- **网络错误**：重试后降级

## 📊 监控和日志

系统会记录以下关键事件：

```javascript
// 验证码验证失败
console.error('CAPTCHA validation attempt 1 failed: Timeout')

// 服务降级
console.warn('CAPTCHA service degraded: HTTP 503. Allowing operation due to fallback policy.')

// 降级状态下处理请求
console.warn('Request processed under CAPTCHA service degradation')
console.warn('Access granted under CAPTCHA service degradation')
```

建议在生产环境中：
1. 监控降级事件的频率
2. 设置告警阈值
3. 定期检查验证码服务健康状态

## 🔒 安全最佳实践

### 1. Token 安全
- Token 一次性使用（默认 `keepToken: false`）
- Token 有时效性，自动过期
- 服务端验证，前端不可伪造

### 2. 配置建议
```javascript
// 生产环境推荐配置
captcha: {
  enabled: true,
  require_on_create: true,      // 必须开启
  require_on_access: false,     // 根据流量决定
  timeout: 5000,                // 适中
  fallback_on_error: true,      // 推荐开启
  max_retries: 2,               // 2-3 次即可
}
```

### 3. 速率限制
建议配合 Cloudflare Workers 的速率限制功能：
- 限制单 IP 的创建频率
- 限制单 IP 的访问频率
- 结合验证码实现多层防护

## 🚀 性能优化

### 1. 缓存策略
- 验证码 token 一次性使用，无需缓存
- 短链接数据使用 KV 存储，自动全球分发

### 2. 并发处理
- 验证码验证异步执行
- 不阻塞其他请求

### 3. 资源加载
```html
<!-- 预加载验证码 SDK -->
<link rel="preload" href="https://captcha.gurl.eu.org/cap.min.js" as="script">
```

## 🧪 测试指南

### 测试验证码集成

```javascript
// 测试脚本
async function testCaptcha() {
  // 1. 获取验证码挑战
  const challenge = await fetch('https://captcha.gurl.eu.org/api/challenge', {
    method: 'POST'
  });
  const challengeData = await challenge.json();
  console.log('Challenge:', challengeData);

  // 2. 模拟用户解答（实际需要用户交互）
  const solutions = [1, 3, 7]; // 示例答案

  // 3. 提交答案
  const redeem = await fetch('https://captcha.gurl.eu.org/api/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: challengeData.token,
      solutions: solutions
    })
  });
  const redeemData = await redeem.json();
  console.log('Redeem:', redeemData);

  // 4. 使用 token 创建短链接
  const create = await fetch('https://your-worker.workers.dev/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://example.com',
      captcha_token: redeemData.token
    })
  });
  const createData = await create.json();
  console.log('Create:', createData);
}
```

### 测试降级策略

```javascript
// 模拟验证码服务故障
captcha: {
  enabled: true,
  api_endpoint: "https://invalid-endpoint.example.com/api", // 无效端点
  fallback_on_error: true, // 应该允许操作
}

// 应该成功创建短链接，并记录降级日志
```

## 📝 故障排查

### 问题 1：验证码总是失败
**检查项**：
- 确认 `captcha.enabled = true`
- 确认 API 端点正确
- 检查 token 是否正确传递
- 查看浏览器控制台错误

### 问题 2：服务经常降级
**检查项**：
- 验证码服务是否稳定
- 网络延迟是否过高
- 考虑增加 `timeout` 值
- 考虑增加 `max_retries` 值

### 问题 3：访问页面需要验证码
**解决方案**：
```javascript
// 如果不想在访问时要求验证码
captcha: {
  require_on_access: false  // 改为 false
}
```

## 🔄 迁移指南

### 从无验证码版本升级

1. **更新代码**：替换 `index.js` 文件
2. **配置验证码**：设置 `captcha` 配置项
3. **更新前端**：添加验证码组件
4. **测试**：确保现有功能正常
5. **监控**：观察降级事件

### 回滚方案

```javascript
// 完全禁用验证码，恢复原有行为
captcha: {
  enabled: false
}
```

## 📞 技术支持

- **验证码服务文档**：参考 CAP Worker 官方文档
- **问题反馈**：提交 GitHub Issue
- **社区讨论**：加入社区论坛

---

**版本**: 2.0.0  
**最后更新**: 2025-11-06
