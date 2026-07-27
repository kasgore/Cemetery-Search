# Cemetery Search — Flask app + automatic data refresher (app.py at repo root)
FROM python:3.12-slim

WORKDIR /app

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

ENV DATA_DIR=/data \
    PORT=8420 \
    REFRESH_HOURS=6

VOLUME /data
EXPOSE 8420

CMD ["python", "app.py"]
