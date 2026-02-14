from typing import List, Optional, Literal
from pydantic import BaseModel, Field

class FunctionEnsure(BaseModel):
    name: str
    state: Literal["present", "absent"]
    streamID: Optional[str] = None

class ResourceEnsure(BaseModel):
    imports: Optional[List[str]] = None
    functions: Optional[List[FunctionEnsure]] = None

class Resource(BaseModel):
    path: str
    ensure: ResourceEnsure

class CodePlanSpec(BaseModel):
    resources: List[Resource]

class CodePlanMetadata(BaseModel):
    description: str

class CodePlanItem(BaseModel):
    apiVersion: str
    kind: str
    metadata: CodePlanMetadata
    spec: CodePlanSpec

class CodePlan(BaseModel):
    codePlan: List[CodePlanItem]
