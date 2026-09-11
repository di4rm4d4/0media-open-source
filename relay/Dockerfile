FROM python:3.12-slim@sha256:2fe5997d249a808b8eeea52c58a1dbffbba28754dc11699ef5c029f2d818ce79

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    RELAY_BIND_HOST=0.0.0.0

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-compile --requirement requirements.txt \
    && groupadd --gid 10001 relay \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin relay

COPY zero_media_relay ./zero_media_relay

USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import json,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2); assert r.status == 200 and json.load(r)['status'] == 'ok'"]

CMD ["python", "-m", "zero_media_relay.server"]
