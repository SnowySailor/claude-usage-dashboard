FROM python:3.13-slim
# tzdata: IANA zones for zoneinfo (day buckets follow the browser's timezone). No other dependencies.
RUN pip install --no-cache-dir tzdata
WORKDIR /app
COPY app/ /app/
ENV USAGE_DB=/data/usage.db PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "server.py"]
