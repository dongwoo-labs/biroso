"""진료기록 접근 역할을 만든다(여러 번 실행해도 된다). README '진료기록'의 역할 표.

  진료         원장. 진료기록 읽기·쓰기(삭제 없음), 특이사항(업스트림) 읽기. AI·도구 없음, 설정 없음.
  Member       직원(기본 역할). 진료기록 접근 없음, 환자 '특이사항(업스트림)'(건강정보가 섞일 수 있음) 못 봄.
  운영 관리    개발·운영 담당. 설정은 바꾸지만 진료기록·특이사항은 못 봄.
  진료기록 봉인 API 키 전용. 진료기록 읽기·고치기만(봉인 칸. 내용은 DB 트리거가 막는다).
  홈페이지 API  API 키 전용(홈페이지·예약·파기). 진료기록 내용 칸·특이사항 못 봄(파기 판단용으로 진료기록 ID만 읽음).

사람에게 역할 주기는 Twenty 설정 > 멤버에서 한다. Admin 역할(Twenty 기본, 바꿀 수 없음)은 진료기록을 볼 수 있으므로
평소에는 아무도 쓰지 않는 비상 계정 하나에만 두고 비밀번호는 원장이 보관한다(README '진료기록').

사용: TWENTY_URL=... TWENTY_API_KEY=<관리자 키> python3 setup_chart_roles.py [--api-key-role <API 키 이름>=<역할>]...
  예) --api-key-role 봉인=진료기록 봉인 --api-key-role 홈페이지=홈페이지 API
"""
import sys
from setup_clinic_objects import gql, objects

RECORD = "medicalRecord"
# 진료기록에서 '홈페이지 API'가 읽어도 되는 칸(내용 없음): 파기 작업이 환자에게 진료기록이 있는지만 본다
RECORD_ID_FIELDS = {"id", "customer", "createdAt", "updatedAt", "deletedAt", "recordStatus"}
HEALTH_FIELDS = [("person", "upstreamNote")]

NONE = dict(canReadObjectRecords=False, canUpdateObjectRecords=False, canSoftDeleteObjectRecords=False, canDestroyObjectRecords=False)
ROLES = {
    "진료": dict(
        role=dict(description="원장. 진료기록 작성·서명. AI 없음", icon="IconStethoscope", canUpdateAllSettings=False, canAccessAllTools=False,
                  canReadAllObjectRecords=True, canUpdateAllObjectRecords=True, canSoftDeleteAllObjectRecords=True, canDestroyAllObjectRecords=False,
                  canBeAssignedToUsers=True, canBeAssignedToApiKeys=False, canBeAssignedToAgents=False),
        objects={RECORD: dict(canReadObjectRecords=True, canUpdateObjectRecords=True, canSoftDeleteObjectRecords=False, canDestroyObjectRecords=False)},
        hide=[], flags=[]),
    "Member": dict(role=None, objects={RECORD: NONE}, hide=HEALTH_FIELDS, flags=None),
    "운영 관리": dict(
        role=dict(description="개발·운영 담당. 설정만, 진료정보 없음", icon="IconSettings", canUpdateAllSettings=True, canAccessAllTools=True,
                  canReadAllObjectRecords=True, canUpdateAllObjectRecords=True, canSoftDeleteAllObjectRecords=True, canDestroyAllObjectRecords=False,
                  canBeAssignedToUsers=True, canBeAssignedToApiKeys=False, canBeAssignedToAgents=False),
        objects={RECORD: NONE}, hide=HEALTH_FIELDS, flags=None),
    "진료기록 봉인": dict(
        role=dict(description="API 키 전용. 진료기록 봉인·무결성 검사", icon="IconLock", canUpdateAllSettings=False, canAccessAllTools=False,
                  canReadAllObjectRecords=False, canUpdateAllObjectRecords=False, canSoftDeleteAllObjectRecords=False, canDestroyAllObjectRecords=False,
                  canBeAssignedToUsers=False, canBeAssignedToApiKeys=True, canBeAssignedToAgents=False),
        objects={RECORD: dict(canReadObjectRecords=True, canUpdateObjectRecords=True, canSoftDeleteObjectRecords=False, canDestroyObjectRecords=False)},
        hide=[], flags=[]),
    "홈페이지 API": dict(
        role=dict(description="API 키 전용. 홈페이지·예약·파기. 진료 내용 없음", icon="IconWorld", canUpdateAllSettings=False, canAccessAllTools=False,
                  canReadAllObjectRecords=True, canUpdateAllObjectRecords=True, canSoftDeleteAllObjectRecords=True, canDestroyAllObjectRecords=True,
                  canBeAssignedToUsers=False, canBeAssignedToApiKeys=True, canBeAssignedToAgents=False),
        objects={RECORD: dict(canReadObjectRecords=True, canUpdateObjectRecords=False, canSoftDeleteObjectRecords=False, canDestroyObjectRecords=False)},
        hide=HEALTH_FIELDS, hide_record_content=True, flags=[]),
}


def roles():
    return {r["label"]: r for r in gql("{getRoles{id label isEditable}}")["getRoles"]}


def main(argv):
    detail = objects(detail=True)
    ids = {name: oid for name, (oid, _) in objects().items()}
    if RECORD not in ids:
        sys.exit("진료기록 객체가 없습니다. setup_clinic_objects.py를 먼저 실행하세요.")
    field_id = lambda obj, name: next(f["id"] for f in detail[obj] if f["name"] == name)
    have = roles()
    for label, spec in ROLES.items():
        if spec["role"] is not None:
            if label in have:
                gql("mutation($i:UpdateRoleInput!){updateOneRole(updateRoleInput:$i){id}}", {"i": {"id": have[label]["id"], "update": {"label": label, **spec["role"]}}})
            else:
                gql("mutation($i:CreateRoleInput!){createOneRole(createRoleInput:$i){id}}", {"i": {"label": label, **spec["role"]}})
            have = roles()
        role_id = have[label]["id"]
        gql("mutation($i:UpsertObjectPermissionsInput!){upsertObjectPermissions(upsertObjectPermissionsInput:$i){objectMetadataId}}",
            {"i": {"roleId": role_id, "objectPermissions": [{"objectMetadataId": ids[o], **p} for o, p in spec["objects"].items()]}})
        hidden = [(o, f) for o, f in spec["hide"]]
        if spec.get("hide_record_content"):
            hidden += [(RECORD, f["name"]) for f in detail[RECORD] if f["name"] not in RECORD_ID_FIELDS and f["type"] not in ("RELATION", "MORPH_RELATION")]
        if hidden:
            gql("mutation($i:UpsertFieldPermissionsInput!){upsertFieldPermissions(upsertFieldPermissionsInput:$i){id}}",
                {"i": {"roleId": role_id, "fieldPermissions": [
                    {"objectMetadataId": ids[o], "fieldMetadataId": field_id(o, f), "canReadFieldValue": False, "canUpdateFieldValue": False} for o, f in hidden]}})
        if spec["flags"] is not None:
            gql("mutation($i:UpsertPermissionFlagsInput!){upsertPermissionFlags(upsertPermissionFlagsInput:$i){id}}",
                {"i": {"roleId": role_id, "permissionFlagKeys": spec["flags"]}})
        print(f"역할 {label}: 진료기록 {spec['objects'][RECORD]}, 가린 칸 {len(hidden)}개")

    # API 키에 역할 주기: --api-key-role 이름=역할
    pairs = [a for i, a in enumerate(argv) if i and argv[i - 1] == "--api-key-role"]
    if pairs:
        keys = {k["name"]: k["id"] for k in gql("{apiKeys{id name revokedAt}}")["apiKeys"] if not k.get("revokedAt")}
        for pair in pairs:
            name, label = pair.split("=", 1)
            gql("mutation($k:UUID!,$r:UUID!){assignRoleToApiKey(apiKeyId:$k,roleId:$r)}", {"k": keys[name], "r": have[label]["id"]})
            print(f"API 키 {name} → {label}")


if __name__ == "__main__":
    main(sys.argv)
