FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libgl1 \
    libglx0 \
    libglib2.0-0 \
    libxrender1 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN mkdir -p /data/artifacts

EXPOSE 8787

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787"]
