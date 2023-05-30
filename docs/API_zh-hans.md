# API接口文档

[English](API.md)

可以通过调用API接口，使用可编程的方式生成短链接

### 接口调用地址

自行部署的CloudFlare Worker地址，例如：https://url.dem0.workers.dev 或是自行绑定的域名

### 调用方式：HTTP POST 请求格式: JSON
示例：
```
{
	"url": "https://example.com"
}
```

### 请求参数:

| 参数名 | 类型 | 说明 |是否必须|示例|
| :----:| :----: | :----: | :----: | :----: |
| url | string | 网址（需包括http://或https://) |必须|https://example.com|

### 响应示例 (JSON)：

```
{
    "status": 200,
    "key": "/demo"
}
```

### 响应参数:
| 参数名 | 类型 | 说明 |示例|
| :----:| :----: | :----: | :----: |
|status|int|	状态码：200为调用成功|200|	
|key|string|	短链接后缀：需要自行添加域名前缀|/xxxxxx|

注：接口只会返回短链接对应的key值，实际使用中需要添加对应的域名前缀，如：示例中返回的key参数是 "/demo" ，则我们需要添加 "https://url.dem0.workers.dev" 作为前缀，将其补全成完整的url即可使用，即：https://url.dem0.workers.dev/demo
