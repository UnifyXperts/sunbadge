frappe.ui.form.on("Traveler", {
    order_status: function (frm) {

        if (!frm.doc.order_status) return;

        const order_status = frm.doc.order_status;

        // -----------------------------
        // EXTRACT STATUS CODE
        // -----------------------------
        const get_code = (status) => parseInt(status?.match(/^\d+/)?.[0]);

        const order_status_code = get_code(order_status);
        if (!order_status_code) return;

        // -----------------------------
        // PARSE executed_status
        // -----------------------------
        let executed = frm.doc.executed_status
            ? frm.doc.executed_status.split(",").map(s => s.trim())
            : [];

        frappe.db.get_doc("Sunbadge Setting").then(settings => {

            const finish_status = settings.status_to_complete_work_order;   // 260
            const invoice_status = settings.status_to_create_sales_invoice; // 280

            const finish_code = get_code(finish_status);
            const invoice_code = get_code(invoice_status);

            const is_finish_done = executed.some(s => get_code(s) === finish_code);
            const is_invoice_done = executed.some(s => get_code(s) === invoice_code);

            if (!is_finish_done && !frm.doc.is_repair_ && order_status_code > finish_code) {
                    frappe.throw({
                        title: "Manufacturing Not Completed",
                        message: "You cannot move ahead. Please complete manufacturing first."
                    });
                }
            // =====================================================
            // 🔴 FULL ROLLBACK (Invoice + Manufacturing)
            // =====================================================
            if (order_status_code < finish_code && is_invoice_done) {

                frappe.confirm(
                    `
                    ⚠️ <b>Sales Invoice and Manufacturing have already been processed .</b><br><br>
                    This will:<br>
                    • Cancel the Sales Invoice<br>
                    • Remove stock entries<br>
                    • Reset Work Orders<br><br>
                    
                     Do you want to continue?
                    `,
                    function () {

                        frappe.call({
                            method: "sunbadge.sunbadge.api.api.cancel_sales_invoice",
                            args: { traveler_name: frm.doc.name },
                            freeze: true
                        });

                        frappe.call({
                            method: "sunbadge.sunbadge.api.api.reset_work_orders",
                            args: { traveler_name: frm.doc.name },
                            freeze: true
                        }).then(() => {

                            frappe.msgprint("Invoice + Manufacturing reverted.");

                            frappe.db.set_value("Traveler", frm.doc.name, {
                                executed_status: "",
                                order_status: order_status
                            }).then(() => frm.reload_doc());
                        });

                    },
                    function () {
                        frm.set_value("order_status", invoice_status);
                    }
                );

                return;
            }

            // =====================================================
            // 🟡 ROLLBACK ONLY MANUFACTURING
            // =====================================================
            if (order_status_code < finish_code && is_finish_done) {

                frappe.confirm(
                    `
                    ⚠️ <b>This Work Order has already been processed.</b><br><br>
                    Do you want to reset the completed Work Order and remove the associated Stock Entries?<br><br>
                    `,
                    function () {

                        frappe.call({
                            method: "sunbadge.sunbadge.api.api.reset_work_orders",
                            args: { traveler_name: frm.doc.name },
                            freeze: true
                        }).then(() => {

                            let updated = executed.filter(s => get_code(s) !== finish_code);

                            frappe.msgprint("Manufacturing reverted.");

                            frappe.db.set_value("Traveler", frm.doc.name, {
                                executed_status: updated.join(", "),
                                order_status: order_status
                            }).then(() => frm.reload_doc());
                        });

                    },
                    function () {
                        frm.set_value("order_status", finish_status);
                    }
                );

                return;
            }

            // =====================================================
            // 🟠 ROLLBACK ONLY INVOICE
            // =====================================================
            if (order_status_code < invoice_code && is_invoice_done) {

                frappe.confirm(
                    `
                    ⚠️ <b>A Sales Invoice has already been created for this Traveler.</b><br><br>
                        Continuing will cancel the existing Sales Invoice .<br><br>
                        Do you want to proceed?
                    `,
                    function () {

                        frappe.call({
                            method: "sunbadge.sunbadge.api.api.cancel_sales_invoice",
                            args: { traveler_name: frm.doc.name },
                            freeze: true
                        }).then(() => {

                            let updated = executed.filter(s => get_code(s) !== invoice_code);

                            frappe.msgprint("Invoice deleted.");

                            frappe.db.set_value("Traveler", frm.doc.name, {
                                executed_status: updated.join(", "),
                                order_status: order_status
                            }).then(() => frm.reload_doc());
                        });

                    },
                    function () {
                        frm.set_value("order_status", invoice_status);
                    }
                );

                return;
            }

            // =====================================================
            // 🟢 EXECUTE MANUFACTURING (260)
            // =====================================================
            if (order_status === finish_status && !is_finish_done) {

                // Skip Work Order creation for Repair
                if (frm.doc.is_repair_) {

                    executed.push(finish_status);

                    frappe.msgprint("Repair Traveler: Work Order skipped.");

                    frappe.db.set_value("Traveler", frm.doc.name, {
                        executed_status: executed.join(", "),
                        order_status: finish_status
                    }).then(() => frm.reload_doc());

                    return;
                }

                frappe.confirm(
                    `
                    Proceed with manufacturing?<br><br>
                    • Stock Entry will be created<br>
                    • Work Orders completed
                    `,
                    function () {

                        frappe.call({
                            method: "sunbadge.sunbadge.api.api.auto_create_stockentry",
                            args: { traveler_name: frm.doc.name },
                            freeze: true
                        }).then(() => {

                            executed.push(finish_status);

                            frappe.msgprint("Manufacturing completed.");

                            frappe.db.set_value("Traveler", frm.doc.name, {
                                executed_status: executed.join(", "),
                                order_status: finish_status
                            }).then(() => frm.reload_doc());
                        });
                    }
                );

                return;
            }

            // =====================================================
            // 🟣 EXECUTE INVOICE (280)
            // =====================================================
            if (order_status === invoice_status && !is_invoice_done) {

                frappe.confirm(
                    `
                    Proceed with Sales Invoice?<br><br>
                    • Invoice will be created
                    `,
                    function () {

                        frappe.call({
                            method: "sunbadge.sunbadge.api.api.create_sales_invoice",
                            args: { traveler_name: frm.doc.name },
                            freeze: true
                        }).then((r) => {

                            executed.push(invoice_status);

                            frappe.msgprint(r.message.message);

                            frappe.db.set_value("Traveler", frm.doc.name, {
                                executed_status: executed.join(", "),
                                order_status: invoice_status
                            }).then(() => frm.reload_doc());
                        });
                    }
                );

                return;
            }

        });
    }
});