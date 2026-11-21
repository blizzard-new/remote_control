FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY relay ./relay
USER 65534:65534
EXPOSE 10000
CMD ["python", "-m", "relay"]
