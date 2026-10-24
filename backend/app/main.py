from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api import router
from app.services.workflows import WorkflowError

app = FastAPI(
    title="Unexpected Delay Response",
    description="When a stockist's deliveries are hit by weather, road closures or landslides, notify affected "
    "retailers with revised ETAs and offer COD retailers trusted stockists who can deliver in time.",
)
app.include_router(router)


@app.exception_handler(WorkflowError)
def workflow_error(_: Request, exc: WorkflowError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/health")
def health():
    return {"ok": True}
