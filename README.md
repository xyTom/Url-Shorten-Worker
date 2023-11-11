# Url-Shorten-Worker

A URL Shortener created using Cloudflare Worker

## API

[API Documentation](docs/API.md)

## Getting started

1. Go to Workers KV and Create a namespace.

![](docs/kv_create_namespace.png)

2. Bind an instance of a KV Namespace to access its data in a Worker.

![](docs/worker_settings.jpg)

3. Where Variable name should set as `LINKS` and KV Namespace is the namespace you just created in the first step.

![](docs/worker_kv_binding.png)

4. Copy the `index.js` code from this project to Cloudflare Worker. 

5. Click Save and Deploy

## Demo

https://alldownload.zip

> [!NOTE]
> Because someone abuse this demo website, all the generated link will automatically expired after 24 hours. For long-term use, please deploy your own.

## Crazypeace modified version

https://github.com/datasense-gh/Url-Shorten-Worker/tree/crazypeace

Supported functions:
* Custom short links
* Short links set by page cache
* Long link text box pre-search localStorage
* Add a button to delete a certain short link
* Password protection