"""
OpenTelemetry 插桩（Python 计算服务侧）。

设计要点：
- 默认关闭：仅当环境变量 OTEL_ENABLED=true 时才真正 import opentelemetry 包。
  这样即使未安装 opentelemetry 依赖，OTEL_ENABLED=false 时启动也零影响（不会 ImportError）。
- 若开启但依赖未装，import 会显式报错（符合预期，提示运维先 uv sync）。
- W3C Trace Context 是默认传播协议，NestJS 转发时注入的 traceparent 会被本服务自动接续，
  从而形成「浏览器→NestJS→Python」的完整调用链。
"""
import os

OTEL_ENDPOINT = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
OTEL_ENABLED = os.getenv("OTEL_ENABLED") == "true"


def setup_tracing():
    """在 app 创建前调用：建立全局 TracerProvider 并把 span 推到 Collector。"""
    if not OTEL_ENABLED:
        return
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
        OTLPSpanExporter,
    )

    provider = TracerProvider()
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=OTEL_ENDPOINT, insecure=True))
    )
    trace.set_tracer_provider(provider)


def instrument_app(app):
    """在 app = FastAPI(...) 之后调用：给 FastAPI 挂请求级 span，并插桩 requests（若回调 Nest）。"""
    if not OTEL_ENABLED:
        return
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.requests import RequestsInstrumentor

    RequestsInstrumentor().instrument()
    FastAPIInstrumentor.instrument_app(app)
