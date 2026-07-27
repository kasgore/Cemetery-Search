# Cemetery Search — Flask app + automatic data refresher
FROM python:3.12-slim

WORKDIR /app

COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# server code + static seeds (geometry, register seed)
COPY server/ /app/
# frontend
COPY index.html app-core.js app-map.js app-ui.js sw.js manifest.webmanifest xlsx.full.min.js cemetery-search.html /app/site/
COPY icons/ /app/site/icons/
# baked dataset as first-boot fallback (the refresher replaces it)
COPY cemetery-data.js /app/site/cemetery-data.js

ENV SITE_DIR=/app/site \
    DATA_DIR=/data \
    PORT=8420 \
    REFRESH_HOURS=6

VOLUME /data
EXPOSE 8420

# waitress: production WSGI server (Flask dev server is single-threaded)
CMD ["python", "-c", "import app, os; from waitress import serve; serve(app.app, host='0.0.0.0', port=int(os.environ.get('PORT','8420')))"]
