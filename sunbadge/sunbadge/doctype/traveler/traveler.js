frappe.ui.form.on("Traveler", {

    refresh: function(frm) {

    if (frm.is_dirty()) {

            setTimeout(() => {
                frm.reload_doc();
            }, 500);
        }

    const wrapper = frm.fields_dict.custom_html?.wrapper;
    
    if (!wrapper) return;

    frappe.call({
        method: "frappe.client.get",
        args: {
            doctype: "Sunbadge Setting",
            name: "Sunbadge Setting"
        },
        callback: function(r) {

            if (!r.message) return;

            const response = r.message;

            console.log(response);

            let messages = [];

            // -----------------------------------
            // ENABLE CHECK
            // -----------------------------------
            if (!response.enabled) {

                messages.push(`
                    <div style="
                        padding:10px;
                        margin-bottom:8px;
                        background:#ffe5e5;
                        border-left:4px solid red;
                        border-radius:6px;
                    ">
                        ❌ <b><a href="/app/sunbadge-setting">
                                Sunbadge Settings
                            </a></b> is not enabled
                    </div>
                `);
            }

            // -----------------------------------
            // REQUIRED FIELDS
            // -----------------------------------
            const required_fields = [
            "status_to_complete_work_order",
            "status_to_create_sales_invoice",
            "status_to_issue_raw_material"
        ];

            required_fields.forEach((field) => {

                const value = response[field];

                if (
                    value === null ||
                    value === undefined ||
                    String(value).trim() === ""
                ) {

                    messages.push(`
                        <div style="
                            padding:10px;
                            margin-bottom:8px;
                            background:#fff4e5;
                            border-left:4px solid orange;
                            border-radius:6px;
                        ">
                            ⚠️ Please fill
                            <b>${frappe.model.unscrub(field)}</b>
                            in
                            <a href="/app/sunbadge-setting">
                                Sunbadge Settings
                            </a>
                        </div>
                    `);
                }
            });

            // -----------------------------------
            // SUCCESS
            // -----------------------------------
            if (!messages.length) {

                messages.push(`
                    <div style="
                        padding:10px;
                        background:#e8fff0;
                        border-left:4px solid green;
                        border-radius:6px;
                    ">
                        ✅ <a href="/app/sunbadge-setting">
                                Sunbadge Settings
                            </a> configured properly
                    </div>
                `);
            }

            // -----------------------------------
            // PUSH HTML
            // -----------------------------------
            $(wrapper).html(messages.join(""));
        }
    });
},
    order_status: function (frm) {
        if (!frm.doc.sales_order || !frm.doc.order_status) {
            return;
        }

        frappe.db.set_value(
            "Sales Order",
            frm.doc.sales_order,
            "custom_order_status",
            frm.doc.order_status
        ).then(() => {

            frappe.show_alert({
                message: __("Sales Order status updated"),
                indicator: "green"
            });

        });

        

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
            const material_issue_status = settings.status_to_issue_raw_material;

            const finish_code = get_code(finish_status);
            const invoice_code = get_code(invoice_status);
            const material_issue_code = get_code(material_issue_status);


            const is_sufficient_material_available =executed.some(s => get_code(s) === material_issue_code);
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
                    ⚠️ <b>Sales Invoice and Manufacturing have already been processed.</b><br><br>
                    This will:<br>
                    • Cancel the Sales Invoice<br>
                    • Remove stock entries<br>
                    • Reset Work Orders<br><br>

                    Do you want to continue?
                    `,
                    function () {

                        frappe.call({
                            method: "sunbadge.sunbadge.api.api.cancel_sales_invoice",
                            args: {
                                traveler_name: frm.doc.name
                            },
                            freeze: true
                        })
                        .then(() => {

                            return frappe.call({
                                method: "sunbadge.sunbadge.api.api.reset_work_orders",
                                args: {
                                    traveler_name: frm.doc.name
                                },
                                freeze: true
                            });

                        })
                        .then(() => {

                            let updated = executed.filter(
                                s => get_code(s) <= material_issue_code
                            );


                            return frappe.db.set_value(
                                "Traveler",
                                frm.doc.name,
                                {
                                    executed_status: updated.join(", "),
                                    order_status: order_status
                                }
                            );

                        })
                        .then(() => {

                            frappe.msgprint(
                                "Invoice + Manufacturing reverted."
                            );

                            frm.reload_doc();

                        })
                        .catch((err) => {

                            console.error(err);

                            frappe.msgprint({
                                title: __("Rollback Failed"),
                                indicator: "red",
                                message: err.message || __("An unexpected error occurred.")
                            });

                        });

                    },
                    function () {

                        frm.set_value(
                            "order_status",
                            invoice_status
                        );

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

                            let updated = executed.filter(s => get_code(s) < finish_code);

                            frappe.msgprint("Manufacturing reverted.");
                            console.log(updated)
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

                            let updated = executed.filter(s => get_code(s) < invoice_code);
                            console.log(updated)
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
            if (
                !is_sufficient_material_available &&
                !frm.doc.is_repair_ &&
                order_status_code > material_issue_code
            ) {

                frappe.throw({
                    title: "Process Skipping Check",
                    message:
                        `You cannot move ahead. Please select status ${material_issue_code} and do the stock transfer if needed.`
                });

            }
    // =====================================================
    // 🔵 CHECK WIP STOCK BEFORE MANUFACTURING (250)
    // =====================================================

    if (
        order_status_code == material_issue_code &&
        order_status_code < finish_code &&
        !frm.doc.is_repair_
    ) {

        frappe.db.get_value(
            "Company",
            frm.doc.company,
            [
                "default_wip_warehouse"
            ]

        ).then((company_res) => {

            let company_data =
                company_res.message || {};

            let target_warehouse =
                company_data.default_wip_warehouse;

            // -------------------------------------------------
            // VALIDATION
            // -------------------------------------------------

            if (!target_warehouse) {

                frappe.throw(`
                    <div>

                        <b style="color:red;">
                            Default WIP Warehouse is not configured
                            for Company:
                        </b>

                        <br><br>

                        <b>
                            ${frm.doc.company}
                        </b>

                    </div>
                `);

                return;
            }

            frappe.call({
                method: "frappe.client.get_list",
                args: {
                    doctype: "Work Order",
                    filters: {
                        sales_order: frm.doc.sales_order,
                        status: "Not Started"
                    },
                    fields: [
                        "name",
                        "source_warehouse"
                    ]
                }

            }).then((wo_res) => {

                let work_orders =
                    wo_res.message || [];

                if (!work_orders.length) {

                    frappe.throw(
                        "No Not Started Work Orders found."
                    );

                }

                let insufficient_items = [];
                let item_map = {};
                let promises = [];

                // -------------------------------------------------
                // LOOP WORK ORDERS
                // -------------------------------------------------

                work_orders.forEach((wo) => {

                    let work_order_promise = frappe.call({
                        method: "frappe.client.get",
                        args: {
                            doctype: "Work Order",
                            name: wo.name
                        }

                    }).then((r) => {

                        let work_order = r.message;

                        let item_promises = (
                            work_order.required_items || []
                        ).map((item) => {

                            // =========================================
                            // GET ITEM GROUP
                            // =========================================

                            return frappe.db.get_value(
                                "Item",
                                item.item_code,
                                "item_group"

                            ).then((item_res) => {

                                let item_group =
                                    item_res.message
                                        ? item_res.message.item_group
                                        : null;

                                if (!item_group) {
                                    return;
                                }

                                // =========================================
                                // GET ITEM GROUP DOC
                                // =========================================

                                return frappe.call({
                                    method: "frappe.client.get",
                                    args: {
                                        doctype: "Item Group",
                                        name: item_group
                                    }

                                }).then((ig_res) => {

                                    let item_group_doc =
                                        ig_res.message || {};

                                    let source_warehouse = null;

                                    // =========================================
                                    // GET SOURCE WAREHOUSE
                                    // =========================================

                                    (
                                        item_group_doc.item_group_defaults || []
                                    ).forEach((row) => {



                                    source_warehouse  =  row.default_warehouse;


                                    });

                                    // fallback
                                    if (!source_warehouse) {

                                        source_warehouse =
                                            wo.source_warehouse;

                                    }

                                    // =========================================
                                    // CHECK STOCK
                                    // =========================================

                                    return frappe.db.get_value(
                                        "Bin",
                                        {
                                            item_code: item.item_code,
                                            warehouse: target_warehouse
                                        },
                                        "actual_qty"

                                    ).then((stock) => {

                                        let available_qty =
                                            stock.message
                                                ? stock.message.actual_qty || 0
                                                : 0;

                                        let required_qty =
                                            item.required_qty || 0;

                                        if (
                                            available_qty <
                                            required_qty
                                        ) {

                                            let key =
                                                item.item_code;

                                            // =========================================
                                            // GROUP ITEMS
                                            // =========================================

                                            if (!item_map[key]) {

                                                item_map[key] = {

                                                    item_code:
                                                        item.item_code,

                                                    source_warehouse:
                                                        source_warehouse || "-",

                                                    target_warehouse:
                                                        target_warehouse || "-",

                                                    required_qty: 0,

                                                    available_qty:
                                                        available_qty,

                                                    shortage_qty: 0
                                                };

                                            }

                                            item_map[key].required_qty +=
                                                required_qty;

                                            item_map[key].shortage_qty =
                                                item_map[key].required_qty -
                                                available_qty;

                                        }

                                    });

                                });

                            });

                        });

                        return Promise.all(item_promises);

                    });

                    promises.push(work_order_promise);

                });

                Promise.all(promises).then(() => {

                    Object.values(item_map).forEach((row) => {

                        insufficient_items.push(`
                            <tr>

                                <td>
                                    ${row.item_code}
                                </td>

                                <td>
                                    ${row.source_warehouse}
                                </td>

                                <td>
                                    ${row.target_warehouse}
                                </td>

                                <td>
                                    ${row.required_qty}
                                </td>

                                <td>
                                    ${row.available_qty}
                                </td>

                                <td>
                                    ${row.shortage_qty}
                                </td>

                                <td>

                                    <button
                                        class="btn btn-xs btn-primary create-stock-entry"
                                        data-item="${row.item_code}"
                                        data-qty="${row.shortage_qty}"
                                        data-source="${row.source_warehouse}"
                                        data-target="${row.target_warehouse}"
                                    >

                                        Create Stock Entry

                                    </button>

                                </td>

                            </tr>
                        `);

                    });

                // =========================================
                // SHOW SHORTAGE DIALOG
                // =========================================

                if (insufficient_items.length) {

                        let first_row = Object.values(item_map)[0];

                        frappe.route_options = {

                            stock_entry_type:
                                "Material Transfer",

                            company:
                                frm.doc.company,

                            from_warehouse:
                                first_row.source_warehouse,

                            to_warehouse:
                                first_row.target_warehouse,

                            items: [
                                {
                                    item_code:
                                        first_row.item_code,

                                    qty:
                                        first_row.shortage_qty,

                                    s_warehouse:
                                        first_row.source_warehouse,

                                    t_warehouse:
                                        first_row.target_warehouse
                                }
                            ]
                        };

                        frappe.throw(`
                            <div>

                                <h4 style="color:red;">
                                    Insufficient Raw Material Available
                                </h4>

                                <p>
                                    Please transfer the required raw materials from the Store Warehouse to the WIP Warehouse to proceed with manufacturing.
                                </p>

                                <br>

                                <a
                                    href="/app/stock-entry/new-stock-entry-1"
                                    target="_blank"
                                    class="btn btn-primary"
                                >
                                    Create Stock Entry
                                </a>

                            </div>
                        `);

                    } else {

                            let executed_status_list = [];

                            if (frm.doc.executed_status) {

                                executed_status_list =
                                    frm.doc.executed_status
                                        .split(",")
                                        .map(d => d.trim())
                                        .filter(Boolean);
                            }

                            if (
                                !executed_status_list.includes(
                                    material_issue_status
                                )
                            ) {

                                executed_status_list.push(
                                    material_issue_status
                                );
                            }

                            frappe.msgprint({
                                title: __("Raw Material Availability"),
                                indicator: "green",
                                message:
                                    "✅ Raw Material is sufficient in the WIP Warehouse.<br><br>Manufacturing can proceed.",

                                primary_action: {
                                    label: __("OK"),

                                    action() {

                                        frm.set_value(
                                            "executed_status",
                                            executed_status_list.join(", ")
                                        );

                                        frm.set_value(
                                            "order_status",
                                            material_issue_status
                                        );

                                        frm.save("Update");

                                        frappe.hide_msgprint();
                                    }
                                }
                            });

                        } 
                        
                            });

                        });

                    });

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