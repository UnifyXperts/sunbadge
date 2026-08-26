frappe.ui.form.on("Sales Order", {
    validate(frm) {
        if (!frm.doc.custom_direct_sales) return;
    
            frm.doc.items.forEach(row => {
                frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "bom_no",
                    ""
                );
            });
},
    setup(frm) {
        
        frm.set_query("item_code", "items", function(doc, cdt, cdn) {

            if (doc.custom_is_repair) {

                return {
                    filters: {
                        disabled: 0,
                        is_stock_item: 0
                    }
                };

            } else {

                return {
                    filters: {
                        disabled: 0,
                        is_stock_item: 1
                    }
                };
            }
        });

        // BOM Filter
        frm.fields_dict.items.grid.get_field('bom_no').get_query = function(doc, cdt, cdn) {

            let row = locals[cdt][cdn];

            return {
                filters: {
                    is_active: 1,
                    docstatus: 1,
                    item: row.item_code
                }
            };
        };
    },
    custom_is_repair(frm){ if(frm.doc.custom_is_repair){
            frm.fields_dict.items.grid.update_docfield_property(
                "custom_customer_description",
                "hidden",
                1
            );
            frm.refresh_field("items");
        }},
    refresh(frm) {
       
        
        if (
            frm.doc.docstatus == 1 &&
            frm.doc.workflow_state !== "Cancelled"
        ) {

            frm.add_custom_button(__("Cancel & Rollback"), function() {

                frappe.confirm(

                    __("This will cancel linked Work Orders / Sales Invoices and revert workflow state.<br><br>Do you want to continue?"),

                    function() {

                        frappe.call({
                            method: "sunbadge.sunbadge.api.api.rollback_traveler",
                            args: {
                                sales_order: frm.doc.name
                            },
                            freeze: true,
                            freeze_message: __("Cancelling linked documents..."),

                            callback: function(r) {

                                frappe.show_alert({
                                    message: __("Rollback completed"),
                                    indicator: "green"
                                });

                                frm.set_value("workflow_state", "Draft");

                                frm.save().then(() => {
                                    window.location.reload();
                                });
                            }
                        });
                    },

                    function() {

                        frappe.show_alert({
                            message: __("Rollback cancelled"),
                            indicator: "orange"
                        });
                    }
                );

            }).addClass("btn-danger");
            
            
            if (frm.doc.workflow_status == "Verified")
                frm.set_df_property("custom_order_status", "read_only", 1);
        
        }
        
        
    },

    before_workflow_action(frm) {

        // Skip validation if not Pending For Approval
        if (frm.doc.workflow_state !== "Pending For Approval") {
            return;
        }

        // Skip BOM validation for Repair Orders
        if (frm.doc.custom_is_repair == 1) {
            return;
        }

        let missing_bom = frm.doc.items.some(row => !row.bom_no);

        if (missing_bom&&!frm.doc.custom_direct_sales) {

            frappe.validated = false;

            frappe.throw({
                title: __("BOM Required"),
                message: __("Please select a BOM for all Sales Order Items before proceeding.")
            });

            return;
        }

        let confirmed = !frm.doc.custom_direct_sales&&confirm(
            "Please review and verify all selected BOMs before approval.\n\nDo you want to continue?"
        );

        if (!confirmed&&!frm.doc.custom_direct_sales) {

    frappe.validated = false;

    frappe.msgprint(__("Workflow action cancelled by user."));

    setTimeout(() => {
        window.location.reload();
    }, 300);

    throw new Error("Workflow Cancelled");
}
        else
            frappe.validated = true;
    },
    custom_reference_sales_order(frm)  {

        if (!frm.doc.custom_reference_sales_order) {

            frm.clear_table("custom_repair_item_table");
            frm.refresh_field("custom_repair_item_table");

            return;
        }

        frappe.call({
            method: "frappe.client.get",
            args: {
                doctype: "Sales Order",
                name: frm.doc.custom_reference_sales_order
            },
            callback: function(r) {

                if (r.message) {

                    // Clear existing rows
                    frm.clear_table("custom_repair_item_table");

                    r.message.items.forEach(function(item) {

                        frappe.db.get_value(
                            "Item",
                            item.item_code,
                            ["image", "custom_customer_description"],
                            function(value) {

                                let row = frm.add_child("custom_repair_item_table");

                                row.repair_item_code = item.item_code;
                                row.item_name = item.item_name;

                                // Fetch custom customer description
                                row.item_description = value.custom_customer_description;

                                row.quantity = item.qty;

                                // Store image path
                                row.image = value.image;

                                // Display image preview
                                row.image_view = value.image;

                                frm.refresh_field("custom_repair_item_table");
                            }
                        );

                    });

                }
            }
        });
    },
    custom_reference_item: async function(frm) {
    if (!frm.doc.custom_reference_item) return;

    const has_service_added = await get_item_and_set_service(
        frm,
        frm.doc.custom_reference_item
    );
    if (has_service_added) {
        frappe.msgprint(
            `Added Service Item For Repair Item <b>${frm.doc.custom_reference_item}</b>`
        );
    } else {
        frappe.msgprint(
            `No Service Item Added For Repair Item <b>${frm.doc.custom_reference_item}</b>`
        );
    }
}
    
});

frappe.ui.form.on("Repairs Traveler Item", {
    repair_item_code(frm) {
        if(frm.doc.custom_is_repair){
        // frm.clear_table("items");

        let promises = [];

        (frm.doc.custom_repair_item_table || []).forEach(repair_row => {

            if (!repair_row.repair_item_code) return;

            promises.push(
                frappe.db.get_doc("Item", repair_row.repair_item_code).then(item => {

                    (item.custom_item_wise_services || []).forEach(service => {

                        let existing = frm.doc.items.find(
                            d => d.item_code === service.service_items
                        );

                        if (existing) {
                            existing.qty += repair_row.quantity || 1;
                        } else {
                            let so_item = frm.add_child("items");
                            so_item.item_code = service.service_items;
                            so_item.qty = repair_row.quantity || 1;

                            // Fetch Item description
                            frappe.db.get_value(
                                "Item",
                                service.service_items,
                                ["item_name", "description","stock_uom"],
                                (r) => {
                                    frappe.model.set_value(
                                        so_item.doctype,
                                        so_item.name,
                                        "item_name",
                                        r.item_name
                                    );
                            
                                    frappe.model.set_value(
                                        so_item.doctype,
                                        so_item.name,
                                        "description",
                                        r.description
                                    );
                                    frappe.model.set_value(
                                        so_item.doctype,
                                        so_item.name,
                                        "uom",
                                        r.stock_uom
                                    );
                                    
                                }
                            );
                        }
                    });
                })
            );
        });

        Promise.all(promises).then(() => {
            frm.refresh_field("items");
        });
    }
    }
});

async function get_item_and_set_service(frm, item_code) {

    try {

        const item = await frappe.db.get_doc("Item", item_code);


        if (!item.custom_item_wise_services || item.custom_item_wise_services.length === 0) {
            return false;
        }

        for (const service of item.custom_item_wise_services) {


            let existing = frm.doc.items.find(
                d => d.item_code === service.service_items
            );


            if (existing) {
                existing.qty += 1;
            } else {

                let so_item = frm.add_child("items");
                so_item.item_code = service.service_items;
                so_item.qty = 1;


                const r = await frappe.db.get_value(
                    "Item",
                    service.service_items,
                    ["item_name", "description", "stock_uom"]
                );


                if (!r.message) {
                    return false;
                }


                frappe.model.set_value(so_item.doctype, so_item.name, {
                    item_name: r.message.item_name,
                    description: r.message.description,
                    uom: r.message.stock_uom
                });

            }
        }


        frm.doc.items = frm.doc.items.filter(row => row.item_code);
        frm.refresh_field("items");

        return true;

    } catch (err) {

        return false;
    }
}