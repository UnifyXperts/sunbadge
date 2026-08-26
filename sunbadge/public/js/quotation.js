frappe.ui.form.on("Quotation", {
    refresh(frm) {
                let html=`<h3 style="color:red; border:1px solid red; text-align:center;">REJECTION INVOICE HAS BEEN CREATED FOR THIS CUSTOMER</h3>`
                const wrapper = frm.fields_dict.custom_warning.$wrapper;
                
                if (!frm.is_new() && frm.doc.custom_is_repair&&frm.doc.custom_reference_quotation)
                     wrapper.html(html);
                
                if (!frm.is_new() && frm.doc.custom_is_repair) {
                frm.doc.custom_is_repair&&!frm.doc.custom_reference_quotation&&frm.add_custom_button(__("Create Rejection Invoice"), () => {
                frappe.call({
                    method: "sunbadge.sunbadge.api.api.create_rejection_invoice",
                    args: {
                        source_name: frm.doc.name
                    },
                    callback(r) {
                        if (r.message) {
                            frappe.set_route("Form", "Quotation", r.message);
                        }
                    }
                });
            }).addClass("btn-danger");
        }

        frm.set_query("custom_reference_quotation", () => ({
            filters: {
                custom_is_repair: 1
            }
        }));
    },
    custom_is_repair(frm){
       frm.set_value("order_type","Maintenance") 
    },
    custom_has_rejected_qty(frm) {
        
        if (!frm.is_new() && frm.doc.custom_is_repair && frm.doc.custom_has_rejected_qty) {
            frm.add_custom_button(__("Create Rejection Invoice"), () => {
                frappe.call({
                    method: "frappe.client.copy",
                    args: {
                        doctype: frm.doctype,
                        name: frm.doc.name
                    },
                    callback(r) {
                        if (r.message) {
                            frappe.set_route("Form", "Quotation", r.message.name);
                        }
                    }
                });
            }).addClass("btn-danger");
        }
    }
});