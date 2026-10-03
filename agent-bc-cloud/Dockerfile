FROM python:3.12-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-fra tesseract-ocr-ara poppler-utils && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && playwright install --with-deps chromium
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin agent
COPY . /app
RUN mkdir -p /app/donnees && chown 10001:10001 /app/donnees /app/config.json /app/company_profile.json
USER 10001:10001
ENV HOME=/home/agent XDG_CACHE_HOME=/tmp/cache BC_SECRETS_DIR=/app/donnees/secrets BC_MAIL_BRIDGE_CONFIG=/app/donnees/secrets/mail_bridge_config.json
CMD ["python", "railway_bootstrap.py"]
