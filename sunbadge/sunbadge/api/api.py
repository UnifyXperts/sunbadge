import frappe
from frappe import _
from frappe.utils import today, getdate, nowdate, flt, cint
from erpnext.manufacturing.doctype.work_order.work_order import make_stock_entry
from erpnext.accounts.utils import get_fiscal_year
from erpnext.selling.doctype.sales_order.sales_order import make_delivery_note



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
        if not bom and not doc.is_repair_:
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
        # source_warehouse=sales_order.set_warehouse

        source_warehouse=None
        
        if not source_warehouse:

            source_warehouse=wip_warehouse

            
        if not source_warehouse:
            frappe.throw(f"No source warehouse found for item {item_code}")

        # -----------------------------
        # CREATE WORK ORDER
        # -----------------------------
        if not doc.is_repair_:

            wo = frappe.new_doc("Work Order")
            wo.production_item = item_code
            wo.qty = qty
            wo.company = doc.company
            wo.bom_no = bom

            wo.fg_warehouse = fg_warehouse
            wo.source_warehouse = source_warehouse
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

        # ---------------------------------
        # PREVENT DUPLICATE MANUFACTURE
        # ---------------------------------
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

            # ---------------------------------
            # CREATE STOCK ENTRY
            # ---------------------------------
            se_dict = make_stock_entry(
                work_order_id=wo_name,
                purpose="Manufacture",
                qty=qty
            )

            se = frappe.get_doc(se_dict)

            # ---------------------------------
            # FETCH WORK ORDER + BOM
            # ---------------------------------
            work_order = frappe.get_doc("Work Order", wo_name)

            bom = frappe.get_doc("BOM", work_order.bom_no)

            labour_per_qty = bom.custom_labor_per_qty or 0

            # ---------------------------------
            # FISCAL YEAR BASED ON TODAY/POSTING DATE
            # ---------------------------------
            fiscal_year = get_fiscal_year(se.posting_date)[0]

            labour_hourly_cost = frappe.db.get_value(
                "Fiscal Year",
                fiscal_year,
                "custom_labor_hourly_cost"
            ) or 0

            # ---------------------------------
            # CALCULATE AMOUNT
            # ---------------------------------
            amount = (
                (qty or 0)
                * labour_per_qty
                * labour_hourly_cost
            )

            # ---------------------------------
            # GET OPERATING COST ACCOUNT
            # ---------------------------------
            operating_account = frappe.db.get_value(
                "Company",
                se.company,
                "default_operating_cost_account"
            )

            # ---------------------------------
            # ADD ADDITIONAL COST ROW
            # ---------------------------------
            if amount > 0 and operating_account:

                se.append("additional_costs", {
                    "expense_account": operating_account,
                    "description": "Operating Cost as per Work Order / BOM",
                    "amount": amount
                })

            # ---------------------------------
            # SAVE + SUBMIT
            # ---------------------------------
            se.insert()
            se.submit()

            # ---------------------------------
            # LINK STOCK ENTRY
            # ---------------------------------
            frappe.db.set_value(
                item.doctype,
                item.name,
                "stock_entry",
                se.name
            )

            frappe.msgprint(f"✅ Stock Entry Created: {se.name}")

        except Exception as e:
            frappe.throw(f"Error for WO {wo_name}: {str(e)}")
            

import frappe
import time
from frappe.exceptions import QueryDeadlockError


@frappe.whitelist()
def reset_work_orders(traveler_name):

    try:

        doc = frappe.get_doc("Traveler", traveler_name)
        items = doc.get("item") or []

        if not items:
            frappe.throw("No items found in Traveler")

        # ---------------------------------------
        # STEP 1: COLLECT ALL STOCK ENTRIES
        # ---------------------------------------
        stock_entry_map = {}

        for item in items:

            wo_name = item.get("work_order")

            if not wo_name:
                continue

            stock_entries = frappe.get_all(
                "Stock Entry",
                filters={"work_order": wo_name},
                fields=[
                    "name",
                    "docstatus",
                    "stock_entry_type",
                    "creation"
                ]
            )

            for se in stock_entries:
                stock_entry_map[se.name] = se

        all_stock_entries = list(stock_entry_map.values())

        # ---------------------------------------
        # STEP 2: REMOVE LINK FROM TRAVELER
        # ---------------------------------------
        for item in items:

            frappe.db.set_value(
                item.doctype,
                item.name,
                {
                    "stock_entry": None,
                },
                update_modified=False
            )

        frappe.db.commit()

        # ---------------------------------------
        # STEP 3: CANCEL + DELETE STOCK ENTRIES
        # ---------------------------------------
        # Manufacture first
        stock_entries_sorted = sorted(
            all_stock_entries,
            key=lambda x: (
                0 if x.stock_entry_type == "Manufacture" else 1,
                x.creation
            )
        )

        for se in stock_entries_sorted:

            for attempt in range(3):

                try:

                    se_doc = frappe.get_doc(
                        "Stock Entry",
                        se.name
                    )

                    frappe.logger().info(
                        f"Reset WO -> Processing {se.name}"
                    )

                    # -----------------------------
                    # CANCEL
                    # -----------------------------
                    if se_doc.docstatus == 1:

                        se_doc.cancel()

                        # release stock locks
                        frappe.db.commit()

                    # -----------------------------
                    # DELETE
                    # -----------------------------
                    frappe.delete_doc(
                        "Stock Entry",
                        se.name,
                        force=1
                    )

                    frappe.db.commit()

                    break

                except QueryDeadlockError:

                    frappe.db.rollback()

                    if attempt == 2:
                        raise

                    time.sleep(2)

                except Exception:
                    frappe.db.rollback()
                    raise

        # ---------------------------------------
        # STEP 4: RESET WORK ORDERS
        # ---------------------------------------
        wo_names = {
            item.get("work_order")
            for item in items
            if item.get("work_order")
        }

        for wo_name in wo_names:

            try:

                wo_doc = frappe.get_doc(
                    "Work Order",
                    wo_name
                )

                # Let ERPNext recalculate
                wo_doc.reload()

                wo_doc.db_set(
                    "produced_qty",
                    0,
                    update_modified=False
                )

                wo_doc.db_set(
                    "material_transferred_for_manufacturing",
                    0,
                    update_modified=False
                )

                wo_doc.db_set(
                    "status",
                    "Not Started",
                    update_modified=False
                )

                frappe.db.commit()

            except Exception:
                frappe.log_error(
                    frappe.get_traceback(),
                    f"Failed resetting WO {wo_name}"
                )
                raise

        frappe.msgprint(
            "✅ Stock unallocated and Work Orders reset successfully"
        )

        return {
            "status": "success",
            "message": "Work Orders reset successfully"
        }

    except Exception:

        frappe.db.rollback()

        frappe.log_error(
            frappe.get_traceback(),
            "Reset Work Orders Failed"
        )

        raise
    



@frappe.whitelist()
def create_sales_invoice(traveler_name):

    try:

        traveler = frappe.get_doc("Traveler", traveler_name)


        message = None

        if not traveler.customer:
            frappe.throw("Customer is required")

        if not traveler.sales_order:
            frappe.throw("Sales Order is required in Traveler")

        so = frappe.get_doc("Sales Order", traveler.sales_order)

        company_doc = frappe.get_doc("Company", so.company)
        finished_goods_warehouse = company_doc.default_fg_warehouse

        default_cc = company_doc.cost_center

        if not default_cc:

            frappe.throw(
                f"Default Cost Center not set in Company {so.company}"
            )

        so_item_map = {
            d.item_code: d
            for d in so.items
        }

        # =========================================================
        # CASE 1 : FULLY BILLED
        # =========================================================

        if flt(so.per_billed) == 100:

            message = (
                "Sales Order is fully billed, so the Delivery Note "
                "was created successfully."
            )

            if not cint(traveler.is_repair_):

                dn = make_delivery_note(so.name)

                dn.set_missing_values()

                # =====================================================
                # ATTACH TRAVELER
                # =====================================================

                dn.custom_traveler = traveler.name

                dn.insert(ignore_permissions=True)

                dn.submit()

                # =====================================================
                # ATTACH DN TO TRAVELER ITEMS
                # =====================================================

                for dn_row in dn.items:

                    for traveler_row in traveler.get("item") or []:

                        if (
                            dn_row.item_code == traveler_row.item_code
                            and flt(dn_row.qty) == flt(traveler_row.quantity)
                        ):
                            frappe.log_error("test",f"{(
                            dn_row.item_code == traveler_row.item_code
                            and flt(dn_row.qty) == flt(traveler_row.quantity)
                        )}")
                            frappe.db.set_value(
                                traveler_row.doctype,
                                traveler_row.name,
                                {
                                    "delivery_note": dn.name,
                                }
                            )

                frappe.db.commit()

                return {
                    "status": "success",
                    "delivery_note": dn.name,
                    "message": message
                }

            return {
                "status": "success",
                "message": "Repair traveler → No DN required"
            }

        # =========================================================
        # CREATE SALES INVOICE
        # =========================================================

        si = frappe.new_doc("Sales Invoice")

        si.customer = traveler.customer
        si.company = so.company

        si.posting_date = frappe.utils.today()
        si.due_date = frappe.utils.today()

        si.currency = so.currency
        si.conversion_rate = so.conversion_rate or 1

        si.price_list_currency = so.currency
        si.plc_conversion_rate = so.conversion_rate or 1

        si.cost_center = default_cc

        si.debit_to = frappe.get_cached_value(
            "Company",
            so.company,
            "default_receivable_account"
        )

        # =========================================================
        # CASE 2 : NOT BILLED
        # =========================================================

        if flt(so.per_billed) == 0:

            message = "Sales Invoice Created Successfully"

            frappe.log_error(
                "DEBUG",
                "SO Not billed → Create SI with update_stock"
            )

            if not cint(traveler.is_repair_):

                si.update_stock = 1



        # =========================================================
        # CASE 3 : PARTIALLY BILLED
        # =========================================================

        elif 0 < flt(so.per_billed) < 100:

            message = (
                "Sales Order is partially billed, so Delivery Note "
                "has been created for billed items and Sales Invoice "
                "has been created for pending items."
            )


            si.update_stock = 0

            if not cint(traveler.is_repair_):

                si.update_stock = 1

            dn = None

            if not cint(traveler.is_repair_):

                dn = frappe.new_doc("Delivery Note")

                dn.customer = so.customer
                dn.company = so.company

            for row in traveler.get("item") or []:

                if row.item_code not in so_item_map:
                    continue

                so_item = so_item_map[row.item_code]

                # -------------------------------------------------
                # ITEM ALREADY BILLED
                # -------------------------------------------------

                if flt(so_item.billed_amt) >= flt(so_item.amount):

                    if dn:

                        dn.append("items", {
                            "item_code": row.item_code,
                            "item_name": so_item.item_name,
                            "qty": row.quantity,
                            "against_sales_order": so.name,
                            "so_detail": so_item.name,
                            "warehouse": finished_goods_warehouse
                        })

                # -------------------------------------------------
                # ITEM NOT BILLED
                # -------------------------------------------------

                else:

                    item_doc = frappe.get_doc(
                        "Item",
                        row.item_code
                    )

                    income_account = frappe.get_cached_value(
                        "Item Default",
                        {
                            "parent": row.item_code,
                            "company": so.company
                        },
                        "income_account"
                    ) or frappe.get_cached_value(
                        "Company",
                        so.company,
                        "default_income_account"
                    )

                    amount = (
                        flt(row.quantity)
                        * flt(so_item.rate)
                    )

                    si.append("items", {
                        "item_code": row.item_code,
                        "item_name": item_doc.item_name,
                        "description": item_doc.description,
                        "qty": row.quantity,
                        "uom": item_doc.stock_uom,
                        "stock_uom": item_doc.stock_uom,
                        "conversion_factor": 1,
                        "rate": so_item.rate,
                        "base_rate": so_item.rate,
                        "amount": amount,
                        "base_amount": amount,
                        "income_account": income_account,
                        "sales_order": so.name,
                        "so_detail": so_item.name,
                        "warehouse": finished_goods_warehouse,
                        "cost_center": default_cc,
                        "allow_zero_valuation_rate": 1
                    })

            # -----------------------------------------------------
            # CREATE DN
            # -----------------------------------------------------

            if dn and dn.items:

                dn.set_missing_values()

                # =====================================================
                # ATTACH TRAVELER
                # =====================================================

                dn.custom_traveler = traveler.name

                dn.insert(ignore_permissions=True)

                dn.submit()

                # =====================================================
                # ATTACH DN TO TRAVELER ITEMS
                # =====================================================

                for dn_row in dn.items:

                    for traveler_row in traveler.get("item") or []:

                        if (
                            dn_row.item_code == traveler_row.item_code
                            and flt(dn_row.qty) == flt(traveler_row.quantity)
                        ):

                            frappe.db.set_value(
                                traveler_row.doctype,
                                traveler_row.name,
                                {
                                    "delivery_note": dn.name,
                                }
                            )


        # =========================================================
        # NORMAL ITEM ADDING
        # =========================================================

        if flt(so.per_billed) == 0:

            for row in traveler.get("item") or []:

                if row.item_code not in so_item_map:

                    frappe.throw(
                        f"Item {row.item_code} not found in Sales Order"
                    )

                so_item = so_item_map[row.item_code]

                item_doc = frappe.get_doc(
                    "Item",
                    row.item_code
                )

                income_account = frappe.get_cached_value(
                    "Item Default",
                    {
                        "parent": row.item_code,
                        "company": so.company
                    },
                    "income_account"
                ) or frappe.get_cached_value(
                    "Company",
                    so.company,
                    "default_income_account"
                )

                amount = (
                    flt(row.quantity)
                    * flt(so_item.rate)
                )

                si.append("items", {
                    "item_code": row.item_code,
                    "item_name": item_doc.item_name,
                    "description": item_doc.description,
                    "qty": row.quantity,
                    
                    # IMPORTANT 
                    "uom": so_item.uom, 
                    "stock_uom": so_item.stock_uom, 
                    "conversion_factor": so_item.conversion_factor,
                    
                    "rate": so_item.rate,
                    "base_rate": so_item.rate,
                    "amount": amount,
                    "base_amount": amount,
                    "income_account": income_account,
                    "sales_order": so.name,
                    "so_detail": so_item.name,
                    "warehouse": finished_goods_warehouse,
                    "cost_center": default_cc,
                    "allow_zero_valuation_rate": 1
                })

        # =========================================================
        # REPAIR ITEMS
        # =========================================================

        for item in traveler.repair_item_table:

            si.append("custom_repair_item_table", {
                "item_code": item.item_code,
                "quantity": item.quantity,
                "item_description": item.item_description,
                "repair_notes": item.repair_notes
            })

        # =========================================================
        # TAXES
        # =========================================================

        for tax in so.taxes:

            si.append("taxes", {
                "charge_type": tax.charge_type,
                "account_head": tax.account_head,
                "description": tax.description,
                "included_in_print_rate": tax.included_in_print_rate,
                "cost_center": tax.cost_center or default_cc,
                "rate": tax.rate,
                "account_currency": tax.account_currency,
                "row_id": tax.row_id
            })

        si.custom_traveler = traveler.name

        # =========================================================
        # SAVE SI
        # =========================================================

        if si.items:

            si.set_missing_values()

            si.calculate_taxes_and_totals()

            si.set_advances()

            si.calculate_taxes_and_totals()

            si.set("payment_schedule", [])

            # si.flags.ignore_validate = True

            # si.save(ignore_permissions=True)
            
            si.insert(ignore_permissions=True)

            si.submit()

            # =====================================================
            # ATTACH SI TO TRAVELER ITEMS
            # =====================================================

            for si_row in si.items:

                for traveler_row in traveler.get("item") or []:

                    if (
                        si_row.item_code == traveler_row.item_code
                        and flt(si_row.qty) == flt(traveler_row.quantity)
                    ):

                        frappe.db.set_value(
                            traveler_row.doctype,
                            traveler_row.name,
                            {
                                "sales_invoice": si.name,
                            }
                        )

            traveler.db_set(
                "sales_invoice",
                si.name
            )


        frappe.db.commit()

        return {
            "status": "success",
            "sales_invoice": si.name if si.items else None,
            "message": message
        }

    except Exception as e:

        frappe.db.rollback()

        frappe.log_error(
            title="Sales Invoice Creation Failed",
            message=frappe.get_traceback()
        )

        frappe.throw(
            f"Failed to create Sales Invoice: {str(e)}"
        )

@frappe.whitelist()
def cancel_sales_invoice(traveler_name):

    traveler = frappe.get_doc("Traveler", traveler_name)

    # if not traveler.sales_invoice:
    #     frappe.throw("No Sales Invoice linked")

    si_name = traveler.sales_invoice

    # ------------------------------------
    # REMOVE PARENT FIELD LINK
    # ------------------------------------
    traveler.db_set("sales_invoice", "", update_modified=False)

    # ------------------------------------
    # REMOVE CHILD TABLE LINKS
    # ------------------------------------
    for row in traveler.item:
        if row.sales_invoice == si_name:
            row.db_set("sales_invoice", "", update_modified=False)

    frappe.db.commit()

    traveler.reload()

    # ------------------------------------
    # CANCEL SALES INVOICE
    # ------------------------------------
    si = frappe.get_doc("Sales Invoice", si_name)

    # si.flags.ignore_links = True

    if si.docstatus == 1:
        si.cancel()

    frappe.delete_doc(
        "Sales Invoice",
        si.name,
        force=True,
        ignore_permissions=True    )

    return {
        "status": "success",
        "message": f"{si.name} cancelled successfully"
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
    
@frappe.whitelist()
def rollback_traveler(sales_order):


    travelers = frappe.get_all(
        "Traveler",
        filters={
            "sales_order": sales_order
        },
        pluck="name"
    )

    for traveler_name in travelers:

        doc = frappe.get_doc(
            "Traveler",
            traveler_name
        )


        if doc.sales_order:

            frappe.db.set_value(
                "Traveler",
                traveler_name,
                "sales_order",
                None
            )


        if doc.sales_invoice and frappe.db.exists(
            "Sales Invoice",
            doc.sales_invoice
        ):

            si_doc = frappe.get_doc(
                "Sales Invoice",
                doc.sales_invoice
            )

            for si_item in si_doc.items:

                if si_item.sales_order == sales_order:

                    si_item.db_set(
                        "sales_order",
                        None,
                        update_modified=False
                    )

                    si_item.db_set(
                        "so_detail",
                        None,
                        update_modified=False
                    )

            frappe.db.commit()


        if doc.sales_invoice:

            frappe.db.set_value(
                "Traveler",
                traveler_name,
                "sales_invoice",
                None
            )


        for row in doc.item:

            if row.work_order:

                work_order = row.work_order

                frappe.db.set_value(
                    row.doctype,
                    row.name,
                    "work_order",
                    None
                )

                if hasattr(row, "stock_entry"):

                    frappe.db.set_value(
                        row.doctype,
                        row.name,
                        "stock_entry",
                        None
                    )

                frappe.db.commit()

                stock_entries = frappe.get_all(
                    "Stock Entry",
                    filters={
                        "work_order": work_order
                    },
                    pluck="name"
                )

                for se_name in stock_entries:

                    if frappe.db.exists(
                        "Stock Entry",
                        se_name
                    ):

                        se_doc = frappe.get_doc(
                            "Stock Entry",
                            se_name
                        )

                        if se_doc.docstatus == 1:
                            se_doc.cancel()

                        frappe.delete_doc(
                            "Stock Entry",
                            se_name,
                            force=1
                        )

                if frappe.db.exists(
                    "Work Order",
                    work_order
                ):

                    wo_doc = frappe.get_doc(
                        "Work Order",
                        work_order
                    )

                    if wo_doc.docstatus == 1:
                        wo_doc.cancel()

                    frappe.delete_doc(
                        "Work Order",
                        work_order,
                        force=1
                    )
    frappe.db.set_value(
        "Sales Order",
        sales_order,
        "workflow_state",
        "Cancelled"
    )

    frappe.db.commit()

    return {
        "status": "success"
    }
    
    
@frappe.whitelist()
def transfer_wip_to_store(traveler_name):

    traveler = frappe.get_doc(
        "Traveler",
        traveler_name
    )

    if not traveler.sales_order:
        frappe.throw(
            "Sales Order not found in Traveler."
        )

    work_orders = frappe.get_all(
        "Work Order",
        filters={
            "sales_order": traveler.sales_order
        },
        fields=[
            "name",
            "wip_warehouse",
            "source_warehouse",
            "company"
        ]
    )

    if not work_orders:
        frappe.throw(
            "No Work Orders found."
        )

    for wo in work_orders:

        work_order = frappe.get_doc(
            "Work Order",
            wo.name
        )

        stock_entry = frappe.new_doc(
            "Stock Entry"
        )

        stock_entry.stock_entry_type = (
            "Material Transfer"
        )

        stock_entry.company = (
            work_order.company
        )

        added = False

        # =================================================
        # LOOP REQUIRED ITEMS
        # =================================================

        for item in work_order.required_items:

            # ---------------------------------------------
            # GET ITEM GROUP
            # ---------------------------------------------

            item_group = frappe.db.get_value(
                "Item",
                item.item_code,
                "item_group"
            )

            target_warehouse = None

            # ---------------------------------------------
            # GET ITEM GROUP DEFAULT WAREHOUSE
            # ---------------------------------------------

            if item_group:

                item_group_doc = frappe.get_doc(
                    "Item Group",
                    item_group
                )

                for row in (
                    item_group_doc.item_group_defaults or []
                ):

                    if row.company == wo.company:

                        target_warehouse = (
                            row.default_warehouse
                        )

                        break

            # fallback
            if not target_warehouse:

                target_warehouse = (
                    wo.source_warehouse
                )

            # ---------------------------------------------
            # CHECK AVAILABLE STOCK IN WIP
            # ---------------------------------------------

            available_qty = frappe.db.get_value(
                "Bin",
                {
                    "item_code":
                        item.item_code,

                    "warehouse":
                        wo.wip_warehouse
                },
                "actual_qty"
            ) or 0

            if available_qty <= 0:
                continue

            # ---------------------------------------------
            # ADD ITEM
            # ---------------------------------------------

            stock_entry.append(
                "items",
                {
                    "item_code":
                        item.item_code,

                    "qty":
                        available_qty,

                    "uom":
                        item.stock_uom,

                    "stock_uom":
                        item.stock_uom,

                    # source = WIP
                    "s_warehouse":
                        wo.wip_warehouse,

                    # target = item group warehouse
                    "t_warehouse":
                        target_warehouse
                }
            )

            added = True

        # =================================================
        # INSERT / SUBMIT
        # =================================================

        if added:

            stock_entry.insert(
                ignore_permissions=True
            )

            stock_entry.submit()

    return {
        "message":
            "WIP materials transferred back successfully."
    }
