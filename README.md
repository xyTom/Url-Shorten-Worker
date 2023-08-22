# Url-Shorten-Worker
A URL Shortener created using Cloudflare Worker

# API

[API Documentation (API文档)](docs/API.md)

# Getting started

Go to Workers KV and create a namespace.

![](docs/kv_create_namespace.png)

Bind an instance of a KV Namespace to access its data in a Worker.

![](docs/worker_settings.jpg)


Where Variable name should set as `LINKS` and KV namespace is the namespace you just created in the first step.

![](docs/worker_kv_binding.png)

Copy the `index.js` code from this project to Cloudflare Worker. 

Click Save and Deploy

# Demo
https://lnks.eu.org/


