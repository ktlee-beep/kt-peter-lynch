# -*- coding: utf-8 -*-
# Render 배포용 진입점 — gunicorn wsgi:app
import importlib, sys

# 한글 파일명 모듈 동적 임포트
spec = importlib.util.spec_from_file_location("kis_backend", "KIS_백엔드.py")
module = importlib.util.module_from_spec(spec)
sys.modules["kis_backend"] = module
spec.loader.exec_module(module)

app = module.app
