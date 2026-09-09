frappe.listview_settings['Sales Order'] = {
    refresh(listview) {

        setTimeout(() => {

            // Remove default Cancel action
            listview.page.actions
                .find('[data-label="Cancel"]')
                .parent()
                .remove();

            // Add custom Cancel action
            listview.page.add_action_item(__('Cancel'), async () => {

                const selected_docs = listview.get_checked_items();

                if (!selected_docs.length) {
                    frappe.msgprint(
                        __('Please select at least one record')
                    );
                    return;
                }

                frappe.confirm(
                    __(
                        `This will cancel linked Travelers and ${selected_docs.length} Sales Order(s). Continue?`
                    ),

                    async () => {

                        frappe.dom.freeze(
                            __('Cancelling linked documents...')
                        );

                        let cancelled_orders = [];
                        let failed_orders = [];

                        try {

                            // ==========================================
                            // PROCESS EACH SALES ORDER
                            // ==========================================

                            for (const sales_order of selected_docs) {

                                try {

                                    console.log(
                                        'Processing Sales Order:',
                                        sales_order.name
                                    );


                                    // ======================================
                                    // CANCEL + DELETE LINKED SALES INVOICES
                                    // ======================================

                                    console.log(
                                        'Fetching linked Sales Invoices for:',
                                        sales_order.name
                                    );


                                    // --------------------------------------
                                    // GET SALES INVOICE ITEMS LINKED TO SO
                                    // --------------------------------------

                                    const invoice_item_response = await frappe.call({
                                        method: 'frappe.client.get_list',

                                        args: {
                                            doctype: 'Sales Invoice Item',

                                            filters: {
                                                sales_order: sales_order.name,
                                                parenttype: 'Sales Invoice'
                                            },

                                            fields: [
                                                'name',
                                                'parent',
                                                'sales_order'
                                            ],

                                            limit_page_length: 0
                                        }
                                    });


                                    const invoice_items =
                                        invoice_item_response.message || [];


                                    console.log(
                                        'Raw linked Sales Invoice Items:',
                                        invoice_items
                                    );


                                    // --------------------------------------
                                    // GET UNIQUE SALES INVOICE NAMES
                                    // --------------------------------------

                                    const invoice_names = [
                                        ...new Set(
                                            invoice_items
                                                .map(item => item.parent)
                                                .filter(parent => parent)
                                        )
                                    ];


                                    console.log(
                                        'Linked Sales Invoice Names:',
                                        invoice_names
                                    );


                                    // ======================================
                                    // PROCESS EACH SALES INVOICE
                                    // ======================================

                                    for (const invoice_name of invoice_names) {

                                        console.log(
                                            'Processing Sales Invoice:',
                                            invoice_name
                                        );

                                        try {

                                            // --------------------------------------
                                            // GET SALES INVOICE
                                            // --------------------------------------

                                            const invoice_response = await frappe.call({
                                                method: 'frappe.client.get',
                                                args: {
                                                    doctype: 'Sales Invoice',
                                                    name: invoice_name
                                                }
                                            });

                                            const invoice = invoice_response.message;

                                            if (!invoice) {
                                                console.warn('Sales Invoice not found:', invoice_name);
                                                continue;
                                            }

                                            // --------------------------------------
                                            // CANCEL IF SUBMITTED
                                            // --------------------------------------

                                            if (invoice.docstatus === 1) {

                                                console.log('Cancelling Sales Invoice:', invoice.name);

                                                await frappe.call({
                                                    method: 'frappe.client.cancel',
                                                    args: {
                                                        doctype: 'Sales Invoice',
                                                        name: invoice.name
                                                    }
                                                });

                                                console.log('Sales Invoice Cancelled:', invoice.name);
                                            }

                                            // --------------------------------------
                                            // DELETE INVOICE
                                            // --------------------------------------

                                            console.log('Deleting Sales Invoice:', invoice.name);

                                            await frappe.call({
                                                method: 'frappe.client.delete',
                                                args: {
                                                    doctype: 'Sales Invoice',
                                                    name: invoice.name
                                                }
                                            });

                                            console.log(
                                                'Sales Invoice Deleted Successfully:',
                                                invoice.name
                                            );

                                        } catch (invoice_error) {

                                            console.error(
                                                'Failed processing Sales Invoice:',
                                                invoice_name,
                                                invoice_error
                                            );

                                            throw invoice_error;
                                        }
                                    }


                                    // =====================================================
                                    // PASTE VERIFICATION CODE HERE
                                    // =====================================================

                                    console.log('Verifying Sales Invoices are deleted...');

                                    const remaining_invoices = [];

                                    for (const invoice_name of invoice_names) {

                                        try {

                                            const check_response = await frappe.call({
                                                method: 'frappe.client.get',
                                                args: {
                                                    doctype: 'Sales Invoice',
                                                    name: invoice_name
                                                }
                                            });

                                            // If it still exists
                                            if (check_response.message) {
                                                remaining_invoices.push(invoice_name);
                                            }

                                        } catch (error) {

                                            // "Not Found" means successfully deleted
                                            console.log(
                                                'Invoice confirmed deleted:',
                                                invoice_name
                                            );
                                        }
                                    }

                                    console.log(
                                        'Remaining Sales Invoices:',
                                        remaining_invoices
                                    );

                                    if (remaining_invoices.length > 0) {

                                        throw new Error(
                                            `Cannot continue. These Sales Invoices still exist: ${remaining_invoices.join(', ')}`
                                        );
                                    }

                                    console.log(
                                        'All Sales Invoices deleted successfully. Continuing with Sales Order...'
                                    );


                                    // =====================================================
                                    // YOUR EXISTING NEXT LOGIC STARTS HERE
                                    // WORK ORDER / TRAVELER / SALES ORDER
                                    // =====================================================


                                    // ======================================
                                    // VERIFY NO SALES INVOICE LINKS REMAIN
                                    // ======================================

                                    console.log(
                                        'Verifying remaining Sales Invoice links...'
                                    );


                                    const verify_invoice_response = await frappe.call({
                                        method: 'frappe.client.get_list',

                                        args: {
                                            doctype: 'Sales Invoice Item',

                                            filters: {
                                                sales_order: sales_order.name,
                                                parenttype: 'Sales Invoice'
                                            },

                                            fields: [
                                                'name',
                                                'parent',
                                                'sales_order'
                                            ],

                                            limit_page_length: 0
                                        }
                                    });


                                    const remaining_invoice_links =
                                        verify_invoice_response.message || [];


                                    console.log(
                                        'Remaining Sales Invoice Links:',
                                        remaining_invoice_links
                                    );


                                    // --------------------------------------
                                    // STOP IF ANY LINK STILL EXISTS
                                    // --------------------------------------

                                    if (remaining_invoice_links.length > 0) {

                                        const remaining_invoice_names = [
                                            ...new Set(
                                                remaining_invoice_links
                                                    .map(item => item.parent)
                                                    .filter(parent => parent)
                                            )
                                        ];


                                        console.error(
                                            'Sales Invoice links still exist:',
                                            remaining_invoice_names
                                        );


                                        throw new Error(
                                            `Cannot cancel Sales Order because linked Sales Invoice(s) still exist: ${remaining_invoice_names.join(', ')}`
                                        );
                                    }


                                    console.log(
                                        'No Sales Invoice links remain. Continuing...'
                                    );

                                    const wo_response =
                                        await frappe.call({
                                            method:
                                                'frappe.client.get_list',

                                            args: {
                                                doctype: 'Work Order',

                                                filters: {
                                                    sales_order:
                                                        sales_order.name
                                                },

                                                fields: [
                                                    'name',
                                                    'docstatus',
                                                    'custom_traveler'
                                                ],

                                                limit_page_length: 0
                                            }
                                        });

                                    const work_orders =
                                        wo_response.message || [];

                                    console.log(
                                        'Work Orders found:',
                                        work_orders
                                    );

                                    // ======================================
                                    // PROCESS EACH WORK ORDER
                                    // ======================================

                                    for (const wo of work_orders) {

                                        console.log(
                                            'Processing Work Order:',
                                            wo.name
                                        );

                                        // ==================================
                                        // CANCEL LINKED TRAVELER
                                        //
                                        // Traveler Server Script will:
                                        // 1. Unlink Work Order
                                        // 2. Cancel Stock Entries
                                        // 3. Delete Stock Entries
                                        // 4. Cancel Work Order
                                        // 5. Delete Work Order
                                        // ==================================

                                        if (wo.custom_traveler) {

                                            console.log(
                                                'Linked Traveler:',
                                                wo.custom_traveler
                                            );

                                            try {

                                                const traveler_response =
                                                    await frappe.call({
                                                        method:
                                                            'frappe.client.get',

                                                        args: {
                                                            doctype:
                                                                'Traveler',

                                                            name:
                                                                wo.custom_traveler
                                                        }
                                                    });

                                                const traveler =
                                                    traveler_response.message;

                                                if (
                                                    traveler &&
                                                    traveler.docstatus === 1
                                                ) {

                                                    console.log(
                                                        'Cancelling Traveler:',
                                                        traveler.name
                                                    );

                                                    await frappe.call({
                                                        method:
                                                            'frappe.client.cancel',

                                                        args: {
                                                            doctype:
                                                                'Traveler',

                                                            name:
                                                                traveler.name
                                                        }
                                                    });

                                                    console.log(
                                                        'Traveler Cancelled:',
                                                        traveler.name
                                                    );
                                                }

                                            } catch (traveler_error) {

                                                console.error(
                                                    'Traveler cancellation failed:',
                                                    traveler_error
                                                );

                                                throw traveler_error;
                                            }
                                        }

                                        // ==================================
                                        // IMPORTANT
                                        // DO NOT CANCEL WORK ORDER HERE
                                        //
                                        // Traveler Server Script already
                                        // cancels + deletes it.
                                        // ==================================

                                        console.log(
                                            'Work Order processing completed:',
                                            wo.name
                                        );
                                    }

                                    // ======================================
                                    // CANCEL SALES ORDER
                                    // ======================================

                                    console.log(
                                        'Cancelling Sales Order:',
                                        sales_order.name
                                    );

                                    await frappe.call({
                                        method:
                                            'frappe.client.cancel',

                                        args: {
                                            doctype:
                                                'Sales Order',

                                            name:
                                                sales_order.name
                                        }
                                    });

                                    console.log(
                                        'Sales Order Cancelled:',
                                        sales_order.name
                                    );

                                    cancelled_orders.push(
                                        sales_order.name
                                    );

                                } catch (error) {

                                    console.error(
                                        `Failed to cancel ${sales_order.name}:`,
                                        error
                                    );

                                    failed_orders.push({
                                        name: sales_order.name,
                                        error:
                                            error.message ||
                                            error.exc ||
                                            'Unknown error'
                                    });
                                }
                            }

                            // ==========================================
                            // SHOW RESULT
                            // ==========================================

                            let message = '';

                            if (cancelled_orders.length) {

                                message += `
                                    <p>
                                        <b>Successfully Cancelled:</b><br>
                                        ${cancelled_orders.join('<br>')}
                                    </p>
                                `;
                            }

                            if (failed_orders.length) {

                                message += `
                                    <p>
                                        <b>Failed:</b><br>
                                        ${failed_orders
                                        .map(
                                            item =>
                                                `${item.name}: ${item.error}`
                                        )
                                        .join('<br>')}
                                    </p>
                                `;
                            }

                            frappe.msgprint({
                                title: __('Cancellation Result'),

                                message:
                                    message ||
                                    __('No records processed'),

                                indicator:
                                    failed_orders.length
                                        ? 'orange'
                                        : 'green'
                            });

                            listview.refresh();

                        } catch (error) {

                            console.error(
                                'Cancellation Error:',
                                error
                            );

                            frappe.msgprint({
                                title:
                                    __('Cancellation Failed'),

                                message:
                                    error.message ||
                                    __('Unable to cancel documents'),

                                indicator: 'red'
                            });

                        } finally {

                            frappe.dom.unfreeze();
                        }
                    }
                );

            });

        }, 100);
    }
};