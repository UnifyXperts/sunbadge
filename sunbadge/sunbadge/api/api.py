from erpnext.manufacturing.doctype.work_order.work_order import make_stock_entry
import frappe
from frappe import _



def auto_manufacture_from_traveler(doc, method=None):

    items = doc.get("item") or []

    if not items:
        frappe.throw("No items found in Traveler")
    
    sales_order=frappe.get_doc("Sales Order",doc.sales_order)
    
    

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
        # -----------------------------
        # FG WAREHOUSE (Company)
        # -----------------------------
        
        fg_warehouse = frappe.db.get_value(
            "Company",
            doc.company,
            "default_fg_warehouse"
        )

        if not fg_warehouse:
            frappe.throw("Default Finished Goods Warehouse not set in Company")

        # -----------------------------
        # WIP WAREHOUSE (Company)
        # -----------------------------
        wip_warehouse = frappe.db.get_value(
            "Company",
            doc.company,
            "default_wip_warehouse"
        )

        if not wip_warehouse:
            frappe.throw("Default WIP Warehouse not set in Company")

        # -----------------------------
        # SOURCE WAREHOUSE (Priority Based)
        # -----------------------------
        source_warehouse=sales_order.set_warehouse
        
        if not source_warehouse:
            frappe.throw(f"No source warehouse found for item {item_code}")

        # -----------------------------
        # CREATE WORK ORDER
        # -----------------------------
        wo = frappe.new_doc("Work Order")
        wo.production_item = item_code
        wo.qty = qty
        wo.company = doc.company
        wo.bom_no = bom

        wo.fg_warehouse = fg_warehouse
        # wo.source_warehouse = source_warehouse
        wo.wip_warehouse = wip_warehouse

        wo.skip_transfer = 1
        wo.sales_order = doc.sales_order
        wo.customer = doc.customer

        wo.custom_traveler=doc.name
        
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
def auto_create_stockentry(traveler_name):

    doc = frappe.get_doc("Traveler", traveler_name)

    items = doc.get("item") or []

    if not items:
        frappe.throw("No items found in Traveler")

    for item in items:

        wo_name = item.get("work_order")
        qty = item.get("quantity") or item.get("qty")

        if not wo_name:
            frappe.throw(f"Work Order not found for item {item.item_code}")

        # -----------------------------
        # PREVENT DUPLICATE MANUFACTURE
        # -----------------------------
        existing_se = frappe.db.exists(
            "Stock Entry",
            {
                "work_order": wo_name,
                "docstatus": 1,
                "stock_entry_type": "Manufacture"
            }
        )

        if existing_se:
            frappe.msgprint(f"Already manufactured for WO {wo_name}: {existing_se}")
            continue

        try:
            # -----------------------------
            # CREATE STOCK ENTRY USING ERPNext LOGIC
            # -----------------------------
            se_dict = make_stock_entry(
                work_order_id=wo_name,
                purpose="Manufacture",
                qty=qty
            )

            se = frappe.get_doc(se_dict)

            # (Optional) let ERP handle validations — safer
            # remove ignore flags unless absolutely required
            # se.flags.ignore_permissions = True

            se.insert()
            se.submit()

            # -----------------------------
            # LINK STOCK ENTRY TO ITEM ROW
            # -----------------------------
            frappe.db.set_value(
                item.doctype,
                item.name,
                "stock_entry",
                se.name
            )

            frappe.msgprint(f"✅ Stock Entry Created: {se.name}")

        except Exception as e:
            frappe.throw(f"Error for WO {wo_name}: {str(e)}")
            

@frappe.whitelist()
def reset_work_orders(traveler_name):

    doc = frappe.get_doc("Traveler", traveler_name)
    items = doc.get("item") or []

    if not items:
        frappe.throw("No items found in Traveler")

    # ---------------------------------------
    # STEP 1: COLLECT ALL STOCK ENTRIES
    # ---------------------------------------
    all_stock_entries = []

    for item in items:
        wo_name = item.get("work_order")
        if not wo_name:
            continue

        stock_entries = frappe.get_all(
            "Stock Entry",
            filters={"work_order": wo_name},
            fields=["name", "docstatus", "stock_entry_type"]
        )
        all_stock_entries.extend(stock_entries)

    # ---------------------------------------
    # STEP 2: REMOVE LINK FROM TRAVELER (DB-LEVEL, WORKS ON SUBMITTED DOC)
    # ---------------------------------------
    for item in items:
        frappe.db.set_value(
            item.doctype,
            item.name,
            {
                "stock_entry": None,
                # "work_order_status": "Not Started"
            }
        )

    # ---------------------------------------
    # STEP 3: CANCEL + DELETE STOCK ENTRIES
    # ---------------------------------------
    # cancel Manufacture first, then others
    stock_entries_sorted = sorted(
        all_stock_entries,
        key=lambda x: 0 if x.stock_entry_type == "Manufacture" else 1
    )

    for se in stock_entries_sorted:
        se_doc = frappe.get_doc("Stock Entry", se.name)

        if se_doc.docstatus == 1:
            se_doc.cancel()

        frappe.delete_doc("Stock Entry", se.name, force=1)

    # ---------------------------------------
    # STEP 4: RESET WORK ORDERS
    # ---------------------------------------
    # (use unique WO list to avoid duplicate fetch)
    wo_names = {item.get("work_order") for item in items if item.get("work_order")}

    for wo_name in wo_names:
        wo_doc = frappe.get_doc("Work Order", wo_name)

        wo_doc.db_set("produced_qty", 0)
        wo_doc.db_set("material_transferred_for_manufacturing", 0)
        # wo_doc.db_set("completed_qty", 0)
        wo_doc.db_set("status", "Not Started")

    frappe.msgprint("✅ Stock unallocated and Work Orders reset successfully")
    

@frappe.whitelist()
def create_sales_invoice(traveler_name):
    traveler = frappe.get_doc("Traveler", traveler_name)

    if not traveler.customer:
        frappe.throw("Customer is required")

    if not traveler.sales_order:
        frappe.throw("Sales Order is required in Traveler")


    so = frappe.get_doc("Sales Order", traveler.sales_order)

    company_doc = frappe.get_doc("Company", so.company)
    default_cc = company_doc.cost_center
    
    

    if not default_cc:
        frappe.throw(f"Default Cost Center not set in Company {so.company}")

    so_item_map = {d.item_code: d for d in so.items}

    # -----------------------------
    # CREATE SALES INVOICE
    # -----------------------------
    si = frappe.new_doc("Sales Invoice")
    si.customer = traveler.customer
    si.posting_date = frappe.utils.today()
    si.company = so.company

    si.cost_center = default_cc
    
    


    # -----------------------------
    # ADD ITEMS FROM TRAVELER
    # -----------------------------
    for row in traveler.get("item") or []:

        if row.item_code not in so_item_map:
            frappe.throw(f"Item {row.item_code} not found in Sales Order")

        so_item = so_item_map[row.item_code]
        
        
        si.append("items", {
            "item_code": row.item_code,
            "qty": row.quantity,
            "rate": so_item.rate,
            "sales_order": so.name,
            "so_detail": so_item.name,
            "warehouse": so_item.warehouse,
            "cost_center": default_cc
        })
    
    for tax in so.taxes:
        si.append("taxes", {
            "charge_type": tax.charge_type,
            "account_head": tax.account_head,
            "description": tax.description,
            "rate": tax.rate,
            "cost_center": tax.cost_center or default_cc
        })

    # Optional: link traveler
    si.custom_traveler = traveler.name
    si.update_stock=1

    si.insert()
    si.submit()

    # -----------------------------
    # SAVE LINK
    # -----------------------------
    traveler.db_set("sales_invoice", si.name)

    return {
        "status": "success",
        "sales_invoice": si.name
    }

@frappe.whitelist()
def cancel_sales_invoice(traveler_name):
    traveler = frappe.get_doc("Traveler", traveler_name)

    if not traveler.sales_invoice:
        frappe.throw("No Sales Invoice linked")

    si_name = traveler.sales_invoice

    # -----------------------------
    # STEP 1: REMOVE LINK FIRST
    # -----------------------------
    frappe.db.set_value("Traveler", traveler.name, "sales_invoice", "")
    frappe.db.commit()   # 🔥 VERY IMPORTANT

    # Reload to avoid stale reference
    si = frappe.get_doc("Sales Invoice", si_name)

    # # -----------------------------
    # # STEP 2: CANCEL PAYMENT ENTRIES
    # # -----------------------------
    # payment_entries = frappe.get_all(
    #     "Payment Entry Reference",
    #     filters={
    #         "reference_name": si.name,
    #         "reference_doctype": "Sales Invoice"
    #     },
    #     fields=["parent"]
    # )

    # for pe in payment_entries:
    #     pe_doc = frappe.get_doc("Payment Entry", pe.parent)

    #     if pe_doc.docstatus == 1:
    #         pe_doc.cancel()

    # -----------------------------
    # STEP 3: CANCEL SALES INVOICE
    # -----------------------------
    if si.docstatus == 1:
        si.cancel()

    frappe.delete_doc("Sales Invoice", si.name, force=1)
    
    return {
        "status": "success",
        "message": f"Sales Invoice {si.name} cancelled"
    }
    
@frappe.whitelist()
def full_reset_traveler(traveler_name):
    doc = frappe.get_doc("Traveler", traveler_name)
    items = doc.get("item") or []

    if not items:
        frappe.throw("No items found")

    # -----------------------------
    # STEP 1: REMOVE SI LINK FIRST
    # -----------------------------
    si_name = doc.sales_invoice

    if si_name:
        frappe.db.set_value("Traveler", doc.name, "sales_invoice", "")
        frappe.db.commit()

    # -----------------------------
    # STEP 2: HANDLE SALES INVOICE
    # -----------------------------
    if si_name:
        si = frappe.get_doc("Sales Invoice", si_name)

        # Cancel Payment Entries
        payment_entries = frappe.get_all(
            "Payment Entry Reference",
            filters={
                "reference_name": si.name,
                "reference_doctype": "Sales Invoice"
            },
            fields=["parent"]
        )

        for pe in payment_entries:
            pe_doc = frappe.get_doc("Payment Entry", pe.parent)
            if pe_doc.docstatus == 1:
                pe_doc.cancel()

        # Cancel SI
        if si.docstatus == 1:
            si.cancel()

        # Optional delete
        frappe.delete_doc("Sales Invoice", si.name, force=1)

    # -----------------------------
    # STEP 3: COLLECT STOCK ENTRIES
    # -----------------------------
    stock_entries = []

    for item in items:
        if item.stock_entry:
            stock_entries.append(item.stock_entry)

    # Remove duplicates
    stock_entries = list(set(stock_entries))

    # -----------------------------
    # STEP 4: REMOVE STOCK ENTRY LINK
    # -----------------------------
    for item in items:
        frappe.db.set_value(
            item.doctype,
            item.name,
            "stock_entry",
            ""
        )

    frappe.db.commit()

    # -----------------------------
    # STEP 5: CANCEL + DELETE STOCK ENTRY
    # -----------------------------
    for se_name in stock_entries:
        se = frappe.get_doc("Stock Entry", se_name)

        if se.docstatus == 1:
            se.cancel()

        frappe.delete_doc("Stock Entry", se.name, force=1)

    # -----------------------------
    # STEP 6: RESET WORK ORDERS
    # -----------------------------
    wo_names = {item.work_order for item in items if item.work_order}

    for wo_name in wo_names:
        wo = frappe.get_doc("Work Order", wo_name)

        wo.db_set("produced_qty", 0)
        wo.db_set("material_transferred_for_manufacturing", 0)
        wo.db_set("status", "Not Started")

    return {
        "status": "success",
        "message": "Traveler fully reset (SI + SE cancelled & deleted)"
    }