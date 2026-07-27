# Cemetery Search — Flask app + automatic data refresher (app.py at repo root)
FROM python:3.12-slim

WORKDIR /app

# openssl CLI generates the self-signed cert for LAN https
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# server + frontend live side by side, exactly like running `python app.py` locally
COPY app.py refresher.py \
     index.html cemetery-search.html \
     app-core.js app-map.js app-ui.js \
     cemetery-data.js xlsx.full.min.js \
     sw.js manifest.webmanifest /app/
COPY icons/ /app/icons/
COPY geometry/ /app/geometry/
COPY seed/ /app/seed/

# conventional internal ports — the stack maps host 80/443 onto them
# (macvlan deployments override with PORT=80 / HTTPS_PORT=443 env vars instead)
ENV DATA_DIR=/data \
    PORT=8420 \
    HTTPS_PORT=8443 \
    CERT_HOSTS=192.168.5.14,localhost \
    REFRESH_HOURS=6

VOLUME /data
EXPOSE 8420 8443

CMD ["python", "app.py"]
