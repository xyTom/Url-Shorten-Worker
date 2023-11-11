# API documentation

(API)

Short links can be generated in a programmable way by calling the API interface

### API call address

Self-deployed CloudFlare Worker address, for example: https://url.demo.workers.dev or a self-bound domain name

### Calling method: HTTP POST Request format: JSON
Example:
````
{
	"url": "https://example.com"
}
````

### Request parameters:

|Parameter name|Type|Description|Required|Example|
| :----:| :----: | :----: | :----: | :----: |
| url | string | URL (must include http:// or https://) | must | https://example.com|

### Example response (JSON):

````
{
    "status": 200,
    "key": "/demo"
}
````

### Response parameters:
|Parameter name|Type|Description|Example|
| :----:| :----: | :----: | :----: |
|status|int| Status code: 200 is a successful call |200|	
|key|string| Short link suffix: you need to add the domain name prefix|/xxxxxx|

Note: The interface will only return the key value corresponding to the short link. In actual use, the corresponding domain name prefix needs to be added. For example, if the key parameter returned in the example is "/demo", we need to add "https://url.demo.workers.dev" as a prefix, it can be used by completing it as a complete url, namely: https://url.demo.workers.dev/demo