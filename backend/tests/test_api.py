from datetime import timedelta

from app.models import Notification


def _network(f):
    s1 = f.stockist("Hill Road Traders", serves=["560001"])
    s2 = f.stockist("Valley Supplies", serves=["560001"])
    f.stock(s2, "SKU1", 50)
    r = f.retailer("Corner Kirana", area="560001")
    r.phone = "+91 98450 12345"
    f.history(r, s2, [1, 2, 2])
    order = f.order(r, s1, promised=f.today + timedelta(days=1))
    f.s.commit()
    return s1, s2, r, order


def test_dry_run_previews_without_persisting(client, f, session):
    s1, _, _, order = _network(f)

    res = client.post("/api/disruptions?dry_run=true", json={"stockist_id": s1.id, "cause": "landslide", "areas": ["560001"]})

    assert res.status_code == 200
    body = res.json()
    assert body["disruption"] is None and body["cod_count"] == 1
    assert body["affected"][0]["order_id"] == order.id
    assert "no past landslide history" in body["delay_basis"]
    assert session.query(Notification).count() == 0


def test_end_to_end_report_set_days_left_and_switch(client, f):
    s1, s2, r, order = _network(f)

    res = client.post("/api/disruptions", json={
        "stockist_id": s1.id, "cause": "road_closure", "areas": ["560001"], "extra_delay_days": 4,
    })
    assert res.status_code == 200 and res.json()["disruption"]["id"]

    feed = client.get("/api/notifications", params={"party_id": r.id}).json()
    assert feed[0]["kind"] == "retailer_delay" and "How many days of stock" in feed[0]["message"]

    alts = client.patch(f"/api/orders/{order.id}/needed-by?notify=true", json={"days_left": 3}).json()
    assert alts["arrives_in_time"] is False
    assert [a["name"] for a in alts["alternatives"]] == ["Valley Supplies"]
    pushed = client.get("/api/notifications", params={"party_id": r.id}).json()[0]
    assert pushed["kind"] == "alternatives" and "Switch to Valley Supplies" in str(pushed["buttons"])

    switched = client.post(f"/api/orders/{order.id}/switch", json={"stockist_id": s2.id}).json()
    assert switched["old_order"]["status"] == "cancelled"
    assert switched["new_order"]["supplier_name"] == "Valley Supplies"

    detail = client.get(f"/api/orders/{order.id}").json()
    assert detail["disruptions"][0]["revised_eta"] == str(f.today + timedelta(days=5))


def test_link_chat_matches_phone_formats(client, f):
    _, _, r, _ = _network(f)
    res = client.post("/api/parties/link-chat", json={"phone": "9845012345", "chat_id": "42"})
    assert res.status_code == 200 and res.json()["id"] == r.id
    assert client.get("/api/parties/by-chat/42").json()["id"] == r.id
    assert client.post("/api/parties/link-chat", json={"phone": "111", "chat_id": "42"}).status_code == 404


def test_workflow_errors_become_400(client, f):
    s1, _, r, order = _network(f)
    client.post(f"/api/orders/{order.id}/events", json={"status": "delivered"})
    res = client.post(f"/api/orders/{order.id}/events", json={"status": "dispatched"})
    assert res.status_code == 400 and "cannot move" in res.json()["detail"]
