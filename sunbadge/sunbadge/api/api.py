from erpnext.manufacturing.doctype.work_order.work_order import make_stock_entry
import frappe


def auto_manufacture_from_traveler(doc, method=None):

    items = doc.get("item") or []

    if not items:
        frappe.throw("No items found in Traveler")

    for item in items:

        item_code = item.get("item_code")
        qty = item.get("quantity") or item.get("qty")
        bom = item.get("bom_no")

        # -----------------------------
        # VALIDATIONS
        # -----------------------------
        if not bom:
            frappe.throw(f"BOM missing for item {item_code}")

        if not qty or qty <= 0:
            frappe.throw(f"Invalid quantity for item {item_code}")

        # -----------------------------
        # SKIP if already linked (important)
        # -----------------------------
        if item.get("work_order"):
            continue

        # -----------------------------
        # CHECK EXISTING WO (row-level safe)
        # -----------------------------
        existing_wo = frappe.db.get_value(
            "Work Order",
            {
                "production_item": item_code,
                "sales_order": doc.sales_order,
                "docstatus": 1
            },
            "name"
        )

        if existing_wo:
            wo_name = existing_wo
        else:
            # -----------------------------
            # GET FG WAREHOUSE
            # -----------------------------
            fg_warehouse = frappe.db.get_value(
                "Item Default",
                {"parent": item_code, "company": doc.company},
                "default_warehouse"
            )

            if not fg_warehouse:
                frappe.throw(f"No FG warehouse set for item {item_code}")

            # -----------------------------
            # CREATE WORK ORDER
            # -----------------------------
            wo = frappe.new_doc("Work Order")
            wo.production_item = item_code
            wo.qty = qty
            wo.company = doc.company
            wo.bom_no = bom

            wo.fg_warehouse = fg_warehouse
            wo.source_warehouse = "Stores - SBC"
            wo.wip_warehouse = "Work In Progress - SBC"

            wo.skip_transfer = 1
            wo.sales_order = doc.sales_order
            wo.customer = doc.customer

            wo.insert(ignore_permissions=True)
            wo.submit()

            wo_name = wo.name

        # -----------------------------
        # ATTACH WO TO ITEM ROW
        # -----------------------------
        if doc.docstatus == 1:
            # if running on submit
            frappe.db.set_value(
                item.doctype,
                item.name,
                "work_order",
                wo_name
            )
        else:
            # before save / validate
            item.work_order = wo_name



@frappe.whitelist()
def auto_create_stockentry(doc):


    required_items = frappe.get_all(
        "BOM Item",
        filters={"parent": bom},
        fields=["item_code", "qty"]
    )

    for rm in required_items:
        required_qty = rm.qty * qty

        available_qty = frappe.db.get_value(
            "Bin",
            {"item_code": rm.item_code, "warehouse": "Stores - SBC"},
            "actual_qty"
        ) or 0

        if available_qty < required_qty:
            frappe.throw(
                f"Not enough stock for {rm.item_code}. Required: {required_qty}, Available: {available_qty}"
            )


    existing_se = frappe.db.exists(
        "Stock Entry",
        {
            "work_order": wo_name,
            "docstatus": 1,
            "stock_entry_type": "Manufacture"
        }
    )

    if existing_se:
        frappe.throw(f"Already manufactured: {existing_se}")
        

    
    try:
        make_se = frappe.get_attr(
            "erpnext.manufacturing.doctype.work_order.work_order.make_stock_entry"
        )

        se_dict = make_se(
            work_order_id=wo_name,
            purpose="Manufacture",
            qty=qty
        )

        # convert dict → doc
        se = frappe.get_doc(se_dict)

        # IMPORTANT FLAGS
        se.flags.ignore_permissions = True
        se.flags.ignore_mandatory = True   # 🔥 IMPORTANT
        se.flags.ignore_validate = True    # 🔥 IMPORTANT

        # SAVE PROPERLY
        se.insert(ignore_permissions=True)

        # reload to ensure name assigned
        se.reload()

        se.submit()

        frappe.msgprint(f"✅ Stock Entry Created: {se.name}")

    except Exception as e:
        frappe.throw(str(e))