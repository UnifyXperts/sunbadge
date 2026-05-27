frappe.listview_settings['Traveler'] = {
    refresh(listview) {

        setTimeout(() => {

            listview.page.actions
                .find('[data-label="Edit"]')
                .parent()
                .remove();

            listview.page.add_action_item(__('Edit'), async () => {

                let selected_docs = listview.get_checked_items();

                if (!selected_docs.length) {
                    frappe.msgprint(__('Please select at least one record'));
                    return;
                }

                const settings_response = await frappe.call({
                method: "frappe.client.get",
                args: {
                    doctype: "Sunbadge Setting",
                    name: "Sunbadge Setting"
                }
            });

            const settings = settings_response.message;

                const work_order_status =
                    settings.status_to_complete_work_order;

                const invoice_status =
                    settings.status_to_create_sales_invoice;

                const work_order_limit = work_order_status
                    ? parseInt(work_order_status.split("-")[0].trim())
                    : 0;

                const invoice_limit = invoice_status
                    ? parseInt(invoice_status.split("-")[0].trim())
                    : 0;

                let invalid_docs = selected_docs.filter(doc => {

                    let status = doc.order_status
                        ? parseInt(doc.order_status.split("-")[0].trim())
                        : 0;

                    return (
                        status === work_order_limit ||
                        status === invoice_limit
                    );
                });

                if (invalid_docs.length) {

                    frappe.msgprint({
                        title: __('Not Allowed'),
                        message: __(
                            `Records with status ${work_order_status} or ${invoice_status} cannot be updated`
                        ),
                        indicator: 'red'
                    });

                    return;
                }

                let d = new frappe.ui.Dialog({
                    title: __('Bulk Update Status'),

                    fields: [
                        {
                            label: __('Order Status'),
                            fieldname: 'order_status',
                            fieldtype: 'Link',
                            options: 'Order Status',
                            reqd: 1,

                            get_query() {
                                return {
                                    filters: [
                                        [
                                            'Order Status',
                                            'name',
                                            'not like',
                                            `%${work_order_limit}%`
                                        ],
                                        [
                                            'Order Status',
                                            'name',
                                            'not like',
                                            `%${invoice_limit}%`
                                        ]
                                    ]
                                };
                            }
                        }
                    ],

                    primary_action_label: __('Update'),

                    async primary_action(values) {

                        let selected_status = values.order_status
                            ? parseInt(values.order_status.split("-")[0].trim())
                            : 0;

                        if (
                            selected_status === work_order_limit ||
                            selected_status === invoice_limit
                        ) {

                            frappe.msgprint({
                                title: __('Not Allowed'),
                                message: __(
                                    `You cannot update status to ${work_order_status} or ${invoice_status}`
                                ),
                                indicator: 'red'
                            });

                            return;
                        }

                        let blocked_docs = selected_docs.filter(doc => {

                            let executed_status = doc.executed_status
                                ? parseInt(doc.executed_status.split("-")[0].trim())
                                : 0;

                            return (
                                executed_status < work_order_limit &&
                                selected_status > work_order_limit
                            );
                        });

                        if (blocked_docs.length) {

                            frappe.msgprint({
                                title: __('Not Allowed'),
                                message: __(
                                    `Executed Status must reach ${work_order_status} before moving ahead`
                                ),
                                indicator: 'red'
                            });

                            return;
                        }

                        let names = selected_docs.map(doc => doc.name);

                        // Bulk update all selected docs
                        for (let name of names) {

                            await frappe.call({
                                method: 'frappe.client.set_value',
                                args: {
                                    doctype: 'Traveler',
                                    name: name,
                                    fieldname: {
                                        order_status: values.order_status
                                    }
                                }
                            });
                        }

                        frappe.msgprint(__('Status Updated Successfully'));

                        d.hide();

                        listview.refresh();
                    }
                });

                d.show();

            });

        }, 100);

    }
};