FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf

COPY index.html manifest.json sw.js app.js /usr/share/nginx/html/
COPY icons  /usr/share/nginx/html/icons
COPY vendor /usr/share/nginx/html/vendor

EXPOSE 80
